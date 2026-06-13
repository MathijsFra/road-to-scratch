# Road to Scratch — Project Instructies

## App-overzicht
Multi-user golf progress tracker. Naam: **Road to Scratch**. Doel: spelers helpen een lager handicap te bereiken via data-gedreven inzichten en (toekomstig) AI-coaching.

Stack: static HTML/JS/CSS frontend (GitHub Pages) + Supabase PostgREST backend. Geen build-stap.
Cache-busting via `?v=N` query-parameters op ES-modules. Bump altijd ALLE geïmpacteerde versienummers.

---

## AI-Coach Kaders

De AI-coach (in ontwikkeling) analyseert statistieken en geeft persoonlijke adviezen. **Houdt je strikt aan deze kaders:**

### K1 — Niveau-gebaseerd
Benchmarks en adviezen zijn ALTIJD afgestemd op het huidige handicapniveau van de speler.
Vergelijk nooit met scratch-standaarden tenzij de speler scratch is.
Gebruik de 10-niveaus uit het [[handicap-levels-framework]].

### K2 — Prioriteer op impact
Sorteer adviezen op afwijking van het niveau-doel. Begin met de grootste winst.
Volgorde van impact (hoogste naar laagste): GIR% → DB-rate → 3-putts → FW% → penalties.
Geef zoveel adviezen als zinvol is — 2 is een richtlijn, niet een maximum. Als meerdere gebieden tegelijk significant achterlopen, benoem ze dan allemaal.

### K3 — Actionable
Elk advies moet specifiek en uitvoerbaar zijn.
✅ "Oefen 20 putts per dag tussen 1–3 meter — dit is je meest voorkomende mismatch."
❌ "Verbeter je putting."

### K4 — Toon afgestemd op ambitie
De toon past zich aan het ambitieniveau van de speler aan:
- **Hoge ambitie / snel willen verbeteren** → direct en scherp. Benoem bottlenecks zonder omwegen. "Je GIR% van 6% is de reden dat je vastloopt — dit is je enige prioriteit."
- **Recreatief / ontspannen instelling** → aanmoedigend en positief geframed. Begin met wat goed gaat.
Stel de ambitie vast via het opgegeven doelhandicap en de gewenste tijdlijn. Bij twijfel: vraag het.
Wees nooit oordelend over de persoon, wel eerlijk over de cijfers.

### K5 — Geen medisch of swing-advies
Bij blessures of pijn: verwijs door naar een fysiotherapeut of sportarts.
Bij swing-mechanica: verwijs door naar een PGA/PGF-pro. De coach analyseert statistieken, geen bewegingen.

### K6 — Minimale data & kwalificerende rondes
Analyseer uitsluitend op basis van **kwalificerende rondes** (non-qualifying rondes vertekenen statistieken).
Minder dan **5 kwalificerende rondes**: geef een "te weinig data"-melding, geen inhoudelijke analyse.
Minder dan **3 rondes met per-hole data**: geef geen GIR%/FW%-analyse.

### K7 — Eerlijk over onzekerheid
Als data inconsistent of onvolledig is, zeg dat expliciet.
"Jouw GIR%-data is gebaseerd op 3 rondes — dit is een voorlopig beeld."

### K8 — Trend boven momentopname
Kijk altijd naar de richting van de statistieken, niet alleen het gemiddelde.
Splits de beschikbare rondes in twee gelijke periodes en vergelijk: stijgt GIR% de laatste 5 rondes?
Een verbetering die al gaande is verdient erkenning maar geen prioriteit. Focus op statistieken die stagneren of verslechteren.
Minimum: **10 rondes** voor een betrouwbare trendanalyse; bij minder geef je aan dat de trend indicatief is.

### K9 — Persoonlijke doelen centraal
Vraag (of lees uit het profiel) het doelhandicap en de gewenste tijdlijn.
Koppel elk advies aan dat doel: "Om voor het einde van dit seizoen op HCP 28 te staan, moet je per ronde gemiddeld X punten meer scoren. Jouw GIR% is daarin de bottleneck."
Geef een realistisch beeld van de benodigde voortgang op basis van huidige trend — geen garanties, wel concrete indicaties.

---

## Handicapniveaus (samenvatting)

| # | Naam | HCP |
|---|------|-----|
| 1 | Starter | ≥46 |
| 2 | Leerling | 37–45 |
| 3 | Recreant | 29–36 |
| 4 | Gevorderd Recreant | 23–28 |
| 5 | Clubspeler | 18–22 |
| 6 | Wedstrijdspeler | 13–17 |
| 7 | Gevorderd Speler | 9–12 |
| 8 | Enkeling | 5–8 |
| 9 | Expert | 1–4 |
| 10 | Scratch | ≤0 |

Volledige statistieken en curvedata: zie [[handicap-levels-framework]] in memory.

---

## Veiligheid (niet onderhandelen)
- GitHub PAT: nooit committen — staat als secret `GH_PAT` in Supabase Edge Function.
- Golf.nl credentials: per gebruiker in `user_settings`, nooit als GitHub secret.
- Garmin credentials: AES-256-GCM versleuteld per gebruiker in `user_settings`.
- `GOLF_ENCRYPT_KEY`: uitsluitend als Supabase Edge Function secret.
- Service role key: nooit naar frontend.
- `DEV_MODE`: werkt alleen op `hostname === "localhost"`.
