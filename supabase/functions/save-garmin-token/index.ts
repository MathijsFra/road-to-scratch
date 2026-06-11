// Supabase Edge Function: save-garmin-token
// -------------------------------------------------------------------
// Slaat een vernieuwd Garmin-sessietoken versleuteld op in user_settings.
//
// Accepteert twee authenticatievormen:
//   1. Service-role key als Bearer → user_id verplicht in body (sync-script)
//   2. Gebruiker-JWT als Bearer   → user_id wordt uit JWT gehaald (garmin_login.py)
//
// Optioneel: stuur ook `username` mee om garmin_username op te slaan.
//
// Deploy:
//   supabase functions deploy save-garmin-token --no-verify-jwt
// -------------------------------------------------------------------

const ENCRYPT_KEY_HEX = Deno.env.get("GOLF_ENCRYPT_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array((hex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
}

async function encryptValue(plaintext: string, hexKey: string): Promise<string> {
  const keyBytes = hexToBytes(hexKey);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(12 + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), 12);
  return btoa(String.fromCharCode(...combined));
}

async function getUserFromJwt(jwt: string): Promise<string | null> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      "Authorization": `Bearer ${jwt}`,
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.id ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!bearerToken) return json({ error: "Unauthorized" }, 401);

  if (!ENCRYPT_KEY_HEX) return json({ error: "GOLF_ENCRYPT_KEY niet ingesteld" }, 500);

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Ongeldige JSON" }, 400);
  }

  const garminToken = body.token;
  if (!garminToken) return json({ error: "token is verplicht" }, 400);

  let userId: string;

  // Pad 1: service-role key → user_id verplicht in body (sync-script).
  const testRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_settings?select=user_id&limit=1`,
    { headers: { "apikey": bearerToken, "Authorization": `Bearer ${bearerToken}` } },
  );

  if (testRes.ok) {
    userId = body.user_id?.trim();
    if (!userId) return json({ error: "user_id verplicht bij service-role auth" }, 400);
  } else {
    // Pad 2: gebruiker-JWT → user_id uit token.
    const uid = await getUserFromJwt(bearerToken);
    if (!uid) return json({ error: "Ongeldige sessie" }, 401);
    userId = uid;
  }

  const encrypted = await encryptValue(garminToken, ENCRYPT_KEY_HEX);

  const upsertBody: Record<string, string> = {
    user_id: userId,
    garmin_token: encrypted,
    updated_at: new Date().toISOString(),
  };
  if (body.username?.trim()) upsertBody.garmin_username = body.username.trim();

  const res = await fetch(`${SUPABASE_URL}/rest/v1/user_settings`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal,resolution=merge-duplicates",
    },
    body: JSON.stringify(upsertBody),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return json({ error: "DB fout: " + (err.message || res.status) }, 500);
  }

  return json({ ok: true });
});
