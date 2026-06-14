// Supabase Edge Function: coach-advice
// -----------------------------------------------------------
// Analyseert golfstatistieken van een ingelogde gebruiker en
// geeft AI-advies via Groq (gratis tier, OpenAI-compatible).
//
// Deploy:
//   supabase functions deploy coach-advice
//   supabase secrets set GROQ_API_KEY=gsk_...
//
// API key aanmaken: https://console.groq.com → API Keys
// -----------------------------------------------------------

const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MODEL = "llama-3.3-70b-versatile";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

async function getUser(jwt: string) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      "Authorization": `Bearer ${jwt}`,
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
    },
  });
  if (!res.ok) return null;
  return await res.json();
}

const SYSTEM_PROMPT = `Je bent een AI-golfcoach die golfers helpt hun handicap te verlagen via data-gedreven adviezen.

Je ontvangt een JSON-object met de statistieken van een golfer. De velden zijn:
- qualifying: aantal kwalificerende rondes
- hasHoleData: aantal rondes met per-hole data (GIR, FW, putts)
- currentHcp: huidig handicap (kan null zijn)
- currentLevel: { level (1=Starter t/m 10=Scratch), name, min, max }
- targetHcp: doelhandicap (null = niet ingesteld)
- targetDate: streefdatum ISO yyyy-mm-dd (null = niet ingesteld)
- targetLevel: niveau voor het doelhandicap
- trends: per statistiek { recent, prev, trend } — recent/prev zijn gemiddelden over de laatste/vorige helft van de rondes, trend = recent − prev (positief = verbetering voor GIR/FW/SD, negatief = verbetering voor 3putts/penalties/doubleBogey)
  - gir: Green In Regulation % (hoger = beter)
  - fairway: Fairway hit % (hoger = beter)
  - threePutts: 3-putts per 18 holes (lager = beter)
  - penalties: strafstreken per 18 holes (lager = beter)
  - doubleBogey: double bogeys als % van holes (lager = beter)
  - sd: Stableford dagresultaat (hoger = beter)
- benchmarks: doelwaarden voor het huidige handicapniveau
  - gir, fairway, threePutts, penalties, doubleBogey
- gaps: voorberekende afwijking per statistiek. POSITIEF = speler zit ONDER de benchmark (verbetering nodig). NEGATIEF of NUL = benchmark al gehaald. NULL = geen data beschikbaar.
  - gir, fairway, threePutts, penalties, doubleBogey
- nextLevelBenchmarks: doelwaarden voor het VOLGENDE handicapniveau (een niveau hoger dan huidig). Null als speler al scratch is.
- nextLevelGaps: zelfde structuur als gaps, maar berekend ten opzichte van nextLevelBenchmarks.

VERPLICHTE KADERS:

K1 — Niveau-gebaseerd: Vergelijk altijd met de benchmarks voor het huidige handicapniveau. Nooit met scratch-standaarden tenzij de speler scratch is.

K2 — Prioriteer op impact: Gebruik uitsluitend het veld "gaps" om te bepalen welke statistieken advies nodig hebben. Geef ALLEEN adviezen voor statistieken met gaps[stat] > 0. Statistieken met gaps[stat] <= 0 of null worden volledig overgeslagen — noem ze nergens, ook niet als compliment of positieve opmerking. Sorteer adviezen op gaps-waarde (hoogste eerst). Impact-volgorde bij gelijke gap: GIR% → DB-rate → 3-putts → FW% → penalties.

Als alle gaps <= 0 zijn (speler haalt alle benchmarks op huidig niveau): gebruik dan "nextLevelGaps" voor de adviezen. Geef adviezen voor de statistieken met de hoogste nextLevelGaps (maximaal 3). Gebruik als doel_waarde de waarde uit nextLevelBenchmarks (niet benchmarks). Vermeld in de samenvatting dat de speler boven het huidige niveau presteert en dat de adviezen gericht zijn op het bereiken van het volgende niveau. Als nextLevelGaps null is (scratch), schrijf dan dat de speler op het hoogste niveau speelt.

K3 — Actionable: Elk advies moet specifiek en uitvoerbaar zijn. Goed: "Oefen dagelijks 20 putts tussen 1–3 meter." Fout: "Verbeter je putting."

K4 — Toon: Doelhandicap ver onder huidig en tijdlijn krap → direct en scherp. Recreatief → aanmoedigend.

K5 — Geen medisch of swing-advies. Verwijs bij blessures naar fysiotherapeut, bij techniek naar een PGA/PGF-pro.

K6 — Minimale data: Als qualifying < 5, stel minimalData=true in. Schrijf een korte uitleg in samenvatting. Adviezen-array leeg laten.

K7 — Eerlijk: Geef aan als data beperkt is, bijv. als hasHoleData < 3 voor GIR/FW-analyse.

K8 — Trend boven momentopname: Een al verbeterende statistiek heeft lagere prioriteit dan een stagnerende of verslechterende.

K9 — Persoonlijke doelen: Koppel adviezen altijd aan targetHcp en targetDate als die beschikbaar zijn.

Geef je antwoord als JSON-object met deze structuur:
{
  "minimalData": false,
  "samenvatting": "1-2 zinnen over de huidige situatie en de meest urgente conclusie",
  "adviezen": [
    {
      "prioriteit": 1,
      "gebied": "GIR%",
      "jouw_waarde": "12%",
      "doel_waarde": "22%",
      "trend": "stabiel",
      "advies": "Specifiek, uitvoerbaar advies in 2-3 zinnen"
    }
  ],
  "doelVoortgang": "Uitleg over voortgang richting doel, of null als er geen doel is"
}

trend-waarden: uitsluitend "verbeterend", "stabiel" of "verslechterend"
Maximaal 5 adviezen. Als minimalData=true: adviezen=[], doelVoortgang=null.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!GROQ_API_KEY) return json({ error: "GROQ_API_KEY is niet ingesteld op de server." }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Niet geauthenticeerd" }, 401);

  const user = await getUser(jwt);
  if (!user?.id) return json({ error: "Ongeldige sessie" }, 401);

  let coachData: unknown;
  try {
    const body = await req.json();
    coachData = body.coachData;
    if (!coachData) throw new Error();
  } catch {
    return json({ error: "coachData is verplicht in de request body" }, 400);
  }

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Analyseer deze golfstatistieken en geef advies:\n${JSON.stringify(coachData, null, 2)}` },
        ],
        max_tokens: 1500,
        temperature: 0.4,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as Record<string, unknown>;
      const msg = (err.error as Record<string, unknown>)?.message ?? `Groq API fout ${res.status}`;
      throw new Error(String(msg));
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const text = data.choices?.[0]?.message?.content ?? "";

    let advice: unknown;
    try {
      advice = JSON.parse(text);
    } catch {
      throw new Error("Kon het advies niet verwerken. Probeer het opnieuw.");
    }

    return json(advice);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
