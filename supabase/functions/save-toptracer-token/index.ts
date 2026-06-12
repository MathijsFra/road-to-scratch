// Supabase Edge Function: save-toptracer-token
// -------------------------------------------------------------------
// Slaat een vernieuwd Toptracer refresh-token versleuteld op.
// Bedoeld voor het sync-script na elke succesvolle API-aanroep.
// body: { user_id: string, token: string }
//
// Deploy:
//   supabase functions deploy save-toptracer-token --no-verify-jwt
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

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Unauthorized" }, 401);
  if (!ENCRYPT_KEY_HEX) return json({ error: "GOLF_ENCRYPT_KEY niet ingesteld" }, 500);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: "Ongeldige JSON" }, 400); }

  const { user_id, token: refreshToken } = body;
  if (!user_id || !refreshToken) return json({ error: "user_id en token zijn verplicht" }, 400);

  const encrypted = await encryptValue(refreshToken);

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_settings?user_id=eq.${user_id}`,
    {
      method: "PATCH",
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify({ toptracer_token: encrypted }),
    },
  );

  if (!res.ok) return json({ error: "DB fout" }, 500);
  return json({ ok: true });
});
