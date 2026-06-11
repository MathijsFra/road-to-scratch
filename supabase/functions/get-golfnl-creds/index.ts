// Supabase Edge Function: get-golfnl-creds
// -------------------------------------------------------------------
// Geeft de GOLF.NL-credentials terug voor een gebruiker, met het
// wachtwoord ontsleuteld. Alleen toegankelijk met de service-role key.
// Bedoeld voor het sync-script (GitHub Actions), niet voor de browser.
//
// Deploy:
//   supabase functions deploy get-golfnl-creds --no-verify-jwt
// -------------------------------------------------------------------

const ENCRYPT_KEY_HEX = Deno.env.get("GOLF_ENCRYPT_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
// Auto-injected by Supabase runtime — used for DB writes.
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

async function decryptPassword(ciphertext: string, hexKey: string): Promise<string> {
  const keyBytes = hexToBytes(hexKey);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"],
  );
  const data = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const iv = data.slice(0, 12);
  const ctTag = data.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ctTag);
  return new TextDecoder().decode(plain);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Unauthorized" }, 401);

  if (!ENCRYPT_KEY_HEX) return json({ error: "GOLF_ENCRYPT_KEY niet ingesteld" }, 500);

  // Verifieer de token door hem te gebruiken voor de DB-query.
  // RLS laat alleen service_role alle rijen zien; een anon/user-token geeft 0 rijen of 401.
  // We sturen de query met de inkomende token; als PostgREST het weigert (401/403) → Forbidden.
  const dbUrl = `${SUPABASE_URL}/rest/v1/user_settings?select=user_id,golfnl_username,golfnl_password&golfnl_username=not.is.null&golfnl_password=not.is.null`;
  const res = await fetch(dbUrl, {
    headers: { "apikey": token, "Authorization": `Bearer ${token}` },
  });

  if (!res.ok) {
    return json({ error: "Forbidden" }, 403);
  }

  const rows: { user_id: string; golfnl_username: string; golfnl_password: string }[] = await res.json();

  const result = await Promise.all(rows.map(async (row) => {
    let password = row.golfnl_password;
    try {
      password = await decryptPassword(row.golfnl_password, ENCRYPT_KEY_HEX);
    } catch {
      // Nog plaintext (backwards compat): geef as-is terug.
    }
    return { user_id: row.user_id, golfnl_username: row.golfnl_username, golfnl_password: password };
  }));

  return json(result);
});
