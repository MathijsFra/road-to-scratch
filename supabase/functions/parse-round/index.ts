// Supabase Edge Function: parse-round
// ------------------------------------------------------------
// Ontvangt 1-2 screenshots (base64) van de GOLF.NL-app en laat
// Claude (vision) de rondegegevens uitlezen. Geeft gestructureerde
// JSON terug die de frontend in het invoerformulier zet.
//
// Deploy:
//   supabase functions deploy parse-round --no-verify-jwt
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
// (--no-verify-jwt zodat de anon-frontend 'm mag aanroepen; de
//  functie zelf is goedkoop en alleen voor jezelf bedoeld.)
// ------------------------------------------------------------

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = "claude-opus-4-8";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `Je leest screenshots van de Nederlandse golf-app GOLF.NL uit en geeft de rondegegevens terug.

Er kunnen twee soorten schermen bij zitten:
1. "Score" / "Speelinfo" / "Details score": datum + tijd, golfbaan, lus (bevat het aantal holes, bv. "9 holes Pluut" -> 9), tee-kleur, baanhandicap, Stableford (STB), totaal aantal slagen, dagresultaat (SD), handicap.
2. "Scorecard": een tabel met per hole de Par, de score, Fairway, GIR, Putts en Penalties, plus totaalkolommen (bv. Fairway 4/7, GIR 2/9).

Regels:
- date: zet om naar ISO yyyy-mm-dd. Nederlandse maanden: jan/feb/mrt(maart)/apr/mei/jun(juni)/jul(juli)/aug/sep/okt/nov/dec.
- holes: 9 of 18, uit de "Lus".
- tee: de kleur (Geel, Rood, Wit, Blauw, Oranje), met hoofdletter.
- sd en hcp: kommagetallen (bv. 37.4, 38.5). Gebruik een punt als decimaalteken.
- Fairway-symbolen op de scorecard: ✓/vinkje = "hit"; pijl naar rechts (↗/→) = "right"; pijl naar links (↖/←) = "left"; kruisje of leeg op een par-3 = null (par 3 heeft geen fairway).
- GIR: vinkje = true, kruisje = false.
- Vul per hole alleen in wat zichtbaar is; gebruik null voor onbekend.
- three_putts = aantal holes met 3 of meer putts.
- double_bogeys = aantal holes met score >= par + 2.
- Als een veld niet zichtbaar is op de aangeleverde schermen, gebruik null (of "" voor course/date als echt onbekend).
- Verzin nooit gegevens; lees alleen af wat er staat.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "date", "course", "holes", "tee", "stb", "sd", "hcp", "score",
    "course_handicap", "putts", "penalties", "gir", "fairways_hit",
    "fairways_total", "three_putts", "double_bogeys", "holes_data",
  ],
  properties: {
    date: { type: "string" },
    course: { type: "string" },
    holes: { anyOf: [{ type: "integer" }, { type: "null" }] },
    tee: { anyOf: [{ type: "string" }, { type: "null" }] },
    stb: { anyOf: [{ type: "integer" }, { type: "null" }] },
    sd: { anyOf: [{ type: "number" }, { type: "null" }] },
    hcp: { anyOf: [{ type: "number" }, { type: "null" }] },
    score: { anyOf: [{ type: "integer" }, { type: "null" }] },
    course_handicap: { anyOf: [{ type: "integer" }, { type: "null" }] },
    putts: { anyOf: [{ type: "integer" }, { type: "null" }] },
    penalties: { anyOf: [{ type: "integer" }, { type: "null" }] },
    gir: { anyOf: [{ type: "integer" }, { type: "null" }] },
    fairways_hit: { anyOf: [{ type: "integer" }, { type: "null" }] },
    fairways_total: { anyOf: [{ type: "integer" }, { type: "null" }] },
    three_putts: { anyOf: [{ type: "integer" }, { type: "null" }] },
    double_bogeys: { anyOf: [{ type: "integer" }, { type: "null" }] },
    holes_data: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["hole", "par", "score", "fairway", "gir", "putts", "penalties"],
        properties: {
          hole: { type: "integer" },
          par: { anyOf: [{ type: "integer" }, { type: "null" }] },
          score: { anyOf: [{ type: "integer" }, { type: "null" }] },
          fairway: { anyOf: [{ type: "string" }, { type: "null" }] },
          gir: { anyOf: [{ type: "boolean" }, { type: "null" }] },
          putts: { anyOf: [{ type: "integer" }, { type: "null" }] },
          penalties: { anyOf: [{ type: "integer" }, { type: "null" }] },
        },
      },
    },
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY niet ingesteld op de server" }, 500);

  let images: { media_type: string; data: string }[] = [];
  try {
    const body = await req.json();
    images = body.images ?? [];
  } catch {
    return json({ error: "Ongeldige request body" }, 400);
  }
  if (!images.length) return json({ error: "Geen afbeeldingen meegestuurd" }, 400);

  const content: unknown[] = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.media_type || "image/jpeg", data: img.data },
  }));
  content.push({ type: "text", text: "Lees deze screenshot(s) van mijn golfronde uit." });

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: SCHEMA },
        },
        messages: [{ role: "user", content }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return json({ error: `Claude API fout (${resp.status})`, detail: errText }, 502);
    }

    const data = await resp.json();
    const textBlock = (data.content ?? []).find((b: { type: string }) => b.type === "text");
    if (!textBlock) return json({ error: "Geen tekst in Claude-antwoord" }, 502);

    let parsed: unknown;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      return json({ error: "Kon antwoord niet als JSON lezen", raw: textBlock.text }, 502);
    }
    return json({ round: parsed });
  } catch (e) {
    return json({ error: "Onverwachte fout", detail: String(e) }, 500);
  }
});
