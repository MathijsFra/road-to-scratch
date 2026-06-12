// Supabase Edge Function: toptracer-auth
// -------------------------------------------------------------------
// GET  → geeft huidige toptracer_auth_status, username terug
// POST → wisselt PKCE auth-code in voor tokens en slaat ze versleuteld op
//        body: { code: string, code_verifier: string }
//
// Deploy:
//   supabase functions deploy toptracer-auth
// -------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ENCRYPT_KEY_HEX = Deno.env.get("GOLF_ENCRYPT_KEY") ?? "";

const TOPTRACER_TOKEN_URL =
  "https://login.toptracer.com/realms/toptracer/protocol/openid-connect/token";
const TOPTRACER_USERINFO_URL =
  "https://login.toptracer.com/realms/toptracer/protocol/openid-connect/userinfo";
const TOPTRACER_CLIENT_ID = "trca";
const TOPTRACER_REDIRECT_URI = "com.toptracer.community.dev:/callback";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array((hex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
}

async function encryptValue(plaintext: string): Promise<string> {
  const keyBytes = hexToBytes(ENCRYPT_KEY_HEX);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, cryptoKey, new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(12 + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), 12);
  return btoa(String.fromCharCode(...combined));
}

async function getUser(jwt: string): Promise<string | null> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { "Authorization": `Bearer ${jwt}`, "apikey": SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!res.ok) return null;
  return (await res.json())?.id ?? null;
}

async function patchSettings(userId: string, fields: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/user_settings?user_id=eq.${userId}`, {
    method: "PATCH",
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(fields),
  });
  return res.ok;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Niet geauthenticeerd" }, 401);

  const userId = await getUser(jwt);
  if (!userId) return json({ error: "Ongeldige sessie" }, 401);

  // GET: status ophalen
  if (req.method === "GET") {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_settings?user_id=eq.${userId}&select=toptracer_auth_status,toptracer_auth_error,toptracer_username`,
      { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
    );
    if (!res.ok) return json({ error: "DB fout" }, 500);
    const row = ((await res.json()) as Record<string, unknown>[])[0] ?? {};
    return json({
      status: row.toptracer_auth_status ?? null,
      error: row.toptracer_auth_error ?? null,
      username: row.toptracer_username ?? null,
    });
  }

  // POST: auth-code inwisselen voor tokens
  if (req.method === "POST") {
    if (!ENCRYPT_KEY_HEX) return json({ error: "GOLF_ENCRYPT_KEY niet ingesteld" }, 500);

    let code: string, codeVerifier: string;
    try {
      const body = await req.json();
      code = String(body.code ?? "").trim();
      codeVerifier = String(body.code_verifier ?? "").trim();
      if (!code || !codeVerifier) throw new Error();
    } catch {
      return json({ error: "code en code_verifier zijn verplicht" }, 400);
    }

    // Status op "pending" zetten
    await patchSettings(userId, { toptracer_auth_status: "pending", toptracer_auth_error: null });

    // Token-uitwisseling bij Toptracer
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: TOPTRACER_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: TOPTRACER_REDIRECT_URI,
    });

    let accessToken: string, refreshToken: string;
    try {
      const tokenRes = await fetch(TOPTRACER_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      if (!tokenRes.ok) {
        const err = await tokenRes.json().catch(() => ({})) as Record<string, string>;
        throw new Error(err.error_description || `HTTP ${tokenRes.status}`);
      }
      const tokenData = await tokenRes.json() as Record<string, string>;
      accessToken = tokenData.access_token;
      refreshToken = tokenData.refresh_token;
      if (!accessToken || !refreshToken) throw new Error("Geen tokens ontvangen");
    } catch (e) {
      await patchSettings(userId, {
        toptracer_auth_status: "failed",
        toptracer_auth_error: (e as Error).message,
      });
      return json({ error: (e as Error).message }, 400);
    }

    // Gebruikersnaam ophalen
    let username = "";
    try {
      const infoRes = await fetch(TOPTRACER_USERINFO_URL, {
        headers: { "Authorization": `Bearer ${accessToken}` },
      });
      if (infoRes.ok) {
        const info = await infoRes.json() as Record<string, string>;
        username = info.email || info.preferred_username || "";
      }
    } catch { /* niet kritiek */ }

    // Token versleuteld opslaan
    const encryptedToken = await encryptValue(refreshToken);
    const ok = await patchSettings(userId, {
      toptracer_token: encryptedToken,
      toptracer_auth_status: "completed",
      toptracer_auth_error: null,
      toptracer_username: username,
    });

    if (!ok) return json({ error: "Token opslaan mislukt" }, 500);
    return json({ ok: true, username });
  }

  return json({ error: "Method not allowed" }, 405);
});
