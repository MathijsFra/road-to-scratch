// Supabase Edge Function: coach-advice
// -----------------------------------------------------------
// Analyseert golfstatistieken via Groq (standaard) of Gemini.
//
// Secrets:
//   supabase secrets set GROQ_API_KEY=gsk_...
//   supabase secrets set GEMINI_API_KEY=AIza...
// -----------------------------------------------------------

const GROQ_API_KEY   = Deno.env.get("GROQ_API_KEY")   ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")  ?? "";
const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")    ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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

// Roept het juiste LLM aan en geeft de ruwe tekstresponse terug.
async function callLLM(provider: string, systemPrompt: string, userMessage: string): Promise<string> {
  if (provider === "gemini") {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is niet ingesteld op de server.");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.4,
            maxOutputTokens: 8192,
          },
        }),
      }
    );
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      const err = data.error as Record<string, unknown> | undefined;
      throw new Error(String(err?.message ?? `Gemini API fout ${res.status}`));
    }
    const candidates = data.candidates as Array<{ content: { parts: Array<{ text: string }> } }>;
    return candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }

  // Default: Groq
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is niet ingesteld op de server.");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      max_tokens: 1500,
      temperature: 0.4,
      response_format: { type: "json_object" },
    }),
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const err = data.error as Record<string, unknown> | undefined;
    throw new Error(String(err?.message ?? `Groq API fout ${res.status}`));
  }
  const choices = data.choices as Array<{ message: { content: string } }>;
  return choices?.[0]?.message?.content ?? "";
}

const SYSTEM_PROMPT = `Je bent een AI-golfcoach die golfers helpt hun handicap te verlagen via data-gedreven adviezen.

Je ontvangt een JSON-object met de statistieken van een golfer. De velden zijn:
- qualifying: aantal kwalificerende rondes
- hasHoleData: aantal rondes met per-hole data (GIR, FW, putts)
- currentHcp: huidig handicap (kan null zijn)
- currentLevel: niveau-object { level (1=Starter t/m 10=Scratch), name, min, max }
- targetHcp: doelhandicap (null = niet ingesteld)
- targetDate: streefdatum ISO yyyy-mm-dd (null = niet ingesteld)
- targetLevel: niveau voor het doelhandicap
- trends: per statistiek { recent, prev, trend } -- recent/prev zijn gemiddelden, trend = recent minus prev
  - gir: Green In Regulation % (hoger = beter)
  - fairway: Fairway hit % (hoger = beter)
  - threePutts: 3-putts per 18 holes (lager = beter)
  - penalties: strafstreken per 18 holes (lager = beter)
  - doubleBogey: double bogeys als % van holes (lager = beter)
  - sd: Stableford dagresultaat (hoger = beter)
- benchmarks: doelwaarden voor het huidige handicapniveau { gir, fairway, threePutts, penalties, doubleBogey }
- gaps: voorberekende afwijking. POSITIEF = speler zit ONDER benchmark (verbetering nodig). NEGATIEF of NUL = benchmark al gehaald. NULL = geen data. { gir, fairway, threePutts, penalties, doubleBogey }
- nextLevelBenchmarks: doelwaarden voor het VOLGENDE niveau (null als scratch)
- nextLevelGaps: zelfde structuur als gaps maar ten opzichte van nextLevelBenchmarks

VERPLICHTE KADERS:

K1 -- Niveau-gebaseerd: Vergelijk altijd met de benchmarks voor het huidige niveau. Nooit met scratch-standaarden tenzij scratch.

K2 -- Prioriteer op impact:
  STAP 1: Controleer gaps. Zijn er statistieken met gaps[stat] > 0? Geef daarvoor adviezen (max 5), gesorteerd op gaps-waarde hoogste eerst. Sla statistieken met gaps[stat] <= 0 of null volledig over -- noem ze nergens.
  STAP 2: Als ALLE gaps <= 0 (speler haalt alle huidige benchmarks): gebruik nextLevelGaps. Geef adviezen voor statistieken met de hoogste nextLevelGaps (max 3). Gebruik als doel_waarde de waarde uit nextLevelBenchmarks. Zet in de samenvatting dat de speler boven het huidige niveau presteert en op weg is naar het volgende niveau. VERPLICHT: elk advies bevat een concrete oefening of trainingssuggestie -- HOE de speler eraan werkt, niet alleen WAT de doelwaarde is. Voorbeeld: "Oefen 2x per week approach shots vanaf 80-130m: 20 ballen naar een cirkel van 10m rondom de pin -- dit is de snelste route naar een hogere GIR%."
  STAP 3: Als ook nextLevelGaps null is (scratch of hoogste niveau): adviezen=[], samenvatting = compliment dat speler op het hoogste niveau presteert.
  Impact-volgorde bij gelijke gap: GIR% -> DB-rate -> 3-putts -> FW% -> penalties.

K3 -- Actionable: Elk advies moet specifiek en uitvoerbaar zijn. Goed: "Oefen dagelijks 20 putts tussen 1-3 meter." Fout: "Verbeter je putting."

K4 -- Toon: Doelhandicap ver onder huidig en tijdlijn krap -> direct en scherp. Recreatief -> aanmoedigend.

K5 -- Geen medisch of swing-advies. Verwijs bij blessures naar fysiotherapeut, bij techniek naar een PGA/PGF-pro.

K6 -- Minimale data: Als qualifying < 5, minimalData=true, adviezen=[], doelVoortgang=null.

K7 -- Eerlijk: Vermeld als data beperkt is, bijv. hasHoleData < 3 voor GIR/FW-analyse.

K8 -- Trend boven momentopname: Verbeterende statistiek heeft lagere prioriteit dan stagnerende of verslechterende.

K9 -- Persoonlijke doelen: Koppel adviezen aan targetHcp en targetDate als die beschikbaar zijn.

K10 -- Follow-up (alleen als VORIGE ANALYSE-SNAPSHOT aanwezig is):
  Begin de samenvatting met een concrete terugkoppeling op de vorige analyse.
  Vergelijk trends.*.recent (huidig) met de vorige snapshot trends.*.recent (vorig).
  Benoem wat verbeterd is (positief) en wat stagneerde of verslechterde.
  Vermeld hoeveel qualifying rondes er zijn bijgekomen (huidig qualifying minus vorig qualifying).
  Voorbeeld samenvatting: "Sinds de vorige analyse heb je 3 rondes gespeeld. Je double bogey rate daalde van 48% naar 41% -- goed werk! Je GIR% zakte echter van 14% naar 11% en verdient nu extra aandacht."
  De adviezen zelf blijven forward-looking op basis van de huidige gaps (K2-logica) -- niet op basis van de vorige adviezen.

Geef je antwoord als JSON:
{
  "minimalData": false,
  "samenvatting": "1-2 zinnen",
  "adviezen": [
    {
      "prioriteit": 1,
      "gebied": "GIR%",
      "jouw_waarde": "12%",
      "doel_waarde": "22%",
      "trend": "stabiel",
      "advies": "Specifiek uitvoerbaar advies in 2-3 zinnen"
    }
  ],
  "doelVoortgang": "Uitleg of null"
}

trend-waarden: uitsluitend "verbeterend", "stabiel" of "verslechterend"
Maximaal 5 adviezen (3 bij next-level modus). Als minimalData=true: adviezen=[], doelVoortgang=null.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Niet geauthenticeerd" }, 401);

  const user = await getUser(jwt);
  if (!user?.id) return json({ error: "Ongeldige sessie" }, 401);

  let coachData: unknown;
  let previousCoachData: unknown = null;
  let provider = "gemini";
  try {
    const body = await req.json();
    coachData = body.coachData;
    if (body.provider === "groq") provider = "groq";
    if (body.previousCoachData) previousCoachData = body.previousCoachData;
    if (!coachData) throw new Error();
  } catch {
    return json({ error: "coachData is verplicht in de request body" }, 400);
  }

  try {
    let userMessage = `Analyseer deze golfstatistieken en geef advies:\n${JSON.stringify(coachData, null, 2)}`;
    if (previousCoachData) {
      userMessage += `\n\nVORIGE ANALYSE-SNAPSHOT (voor vergelijking -- gebruik dit voor de terugkoppeling in de samenvatting):\n${JSON.stringify(previousCoachData, null, 2)}`;
    }
    const text = await callLLM(provider, SYSTEM_PROMPT, userMessage);

    let advice: unknown;
    try {
      // Gemini kan soms markdown code fences teruggeven (```json ... ```)
      const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      advice = JSON.parse(clean);
    } catch {
      throw new Error(`Kon het advies niet verwerken. Raw response: ${text.slice(0, 300)}`);
    }

    return json(advice);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
