// Supabase Edge Function: coach-advice v24
// -----------------------------------------------------------
// Analyseert golfstatistieken via Gemini (standaard) of Groq.
// Slaat elke analyse op in coach_analyses en haalt de laatste 3
// op als geheugen voor de coach (K10 terugkoppeling).
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

// ---------- Analyse-geschiedenis ----------

interface HistoryRow {
  created_at: string;
  qualifying_count: number;
  coach_data: Record<string, unknown>;
  advice: Record<string, unknown>;
}

async function fetchHistory(userId: string): Promise<HistoryRow[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return [];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_analyses?user_id=eq.${userId}&order=created_at.desc&limit=3&select=created_at,qualifying_count,coach_data,advice`,
      {
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (!res.ok) return [];
    const rows = await res.json() as HistoryRow[];
    return rows.reverse(); // oudste eerst voor de prompt
  } catch { return []; }
}

function buildHistoryContext(history: HistoryRow[]): string {
  if (history.length === 0) return "";

  const entries = history.map(row => {
    const cd  = row.coach_data;
    const adv = row.advice;
    const trends = cd.trends as Record<string, { recent: number | null }> | undefined;

    const statistieken: Record<string, number | null> = {};
    if (trends) {
      for (const [key, val] of Object.entries(trends)) {
        statistieken[key] = val?.recent ?? null;
      }
    }

    const adviezenGegeven = Array.isArray(adv?.adviezen)
      ? (adv.adviezen as Array<{ gebied?: string; jouw_waarde?: string; doel_waarde?: string }>)
          .map(a => `${a.gebied}: jouw waarde ${a.jouw_waarde}, doel ${a.doel_waarde}`)
      : [];

    return {
      datum: row.created_at.split("T")[0],
      qualifying: row.qualifying_count,
      currentHcp: cd.currentHcp ?? null,
      statistieken,
      samenvatting: adv?.samenvatting ?? null,
      adviezen_gegeven: adviezenGegeven,
    };
  });

  const n = entries.length;
  return `\n\nANALYSE-GESCHIEDENIS (${n} eerdere analys${n === 1 ? "e" : "es"}, oudste eerst — gebruik voor K10 terugkoppeling):\n${JSON.stringify(entries, null, 2)}`;
}

// Fire-and-forget: vertraagt de response niet
function saveAnalysis(
  userId: string,
  provider: string,
  coachData: unknown,
  advice: unknown,
  qualifyingCount: number,
) {
  fetch(`${SUPABASE_URL}/rest/v1/coach_analyses`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({
      user_id: userId,
      provider,
      coach_data: coachData,
      advice,
      qualifying_count: qualifyingCount,
    }),
  }).catch(err => console.error("saveAnalysis failed:", err));
}

// ---------- LLM ----------

async function callLLM(
  provider: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  if (provider === "groq") {
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
          { role: "user",   content: userMessage },
        ],
        max_tokens: 2000,
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

  // Default: Gemini
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

  // Log tokenverbruik zodat we kunnen bewaken of limieten in zicht komen
  const usage = data.usageMetadata as {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  } | undefined;
  if (usage) {
    console.log(
      `Gemini tokens — input: ${usage.promptTokenCount}, output: ${usage.candidatesTokenCount}, totaal: ${usage.totalTokenCount}`,
    );
  }

  const candidates = data.candidates as Array<{ content: { parts: Array<{ text: string }> } }>;
  return candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

// ---------- System prompt ----------

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

K10 -- Follow-up (alleen als ANALYSE-GESCHIEDENIS aanwezig is in het bericht):
  Begin de samenvatting met een concrete terugkoppeling op de meest recente vorige analyse.
  Vergelijk statistieken van de meest recente vorige analyse met de huidige waarden.
  Benoem wat verbeterd is (positief) en wat stagneerde of verslechterde.
  Vermeld hoeveel qualifying rondes er zijn bijgekomen t.o.v. de meest recente vorige analyse.
  Als er meerdere eerdere analyses zijn en er een duidelijk langere-termijn patroon zichtbaar is, benoem dat dan kort.
  Voorbeeld: "Sinds de vorige analyse (3 rondes geleden) daalde je double bogey rate van 48% naar 41% -- goed werk! Je GIR% zakte echter van 14% naar 11% en verdient nu extra aandacht."
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
      "advies": "Specifiek uitvoerbaar advies inclusief concrete oefening in 2-3 zinnen"
    }
  ],
  "doelVoortgang": "Uitleg of null"
}

trend-waarden: uitsluitend "verbeterend", "stabiel" of "verslechterend"
Maximaal 5 adviezen (3 bij next-level modus). Als minimalData=true: adviezen=[], doelVoortgang=null.`;

// ---------- Handler ----------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Niet geauthenticeerd" }, 401);

  const user = await getUser(jwt);
  if (!user?.id) return json({ error: "Ongeldige sessie" }, 401);

  let coachData: unknown;
  let provider = "gemini";
  try {
    const body = await req.json();
    coachData = body.coachData;
    if (body.provider === "groq") provider = "groq";
    if (!coachData) throw new Error();
  } catch {
    return json({ error: "coachData is verplicht in de request body" }, 400);
  }

  try {
    // Haal analyse-geschiedenis op voor K10 terugkoppeling
    const history = await fetchHistory(user.id);
    const historyContext = buildHistoryContext(history);

    const userMessage =
      `Analyseer deze golfstatistieken en geef advies:\n${JSON.stringify(coachData, null, 2)}` +
      historyContext;

    const text = await callLLM(provider, SYSTEM_PROMPT, userMessage);

    let advice: unknown;
    try {
      const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      advice = JSON.parse(clean);
    } catch {
      throw new Error(`Kon het advies niet verwerken. Raw response: ${text.slice(0, 300)}`);
    }

    // Sla op voor toekomstige terugkoppeling (fire-and-forget)
    const qualifyingCount = (coachData as Record<string, unknown>)?.qualifying as number ?? 0;
    saveAnalysis(user.id, provider, coachData, advice, qualifyingCount);

    return json(advice);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
