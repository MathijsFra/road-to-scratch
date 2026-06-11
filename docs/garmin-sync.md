# Garmin Connect koppelen (shot-stats per hole)

GOLF.NL levert je scores, handicap en par/score per hole. **Garmin Connect** vult
daar de shot-stats bij aan: **putts, fairways en penalties per hole** (GIR wordt
zelf berekend uit par en slagen − putts). De koppeling matcht je Garmin-scorekaarten
op **datum** aan de GOLF.NL-rondes in Supabase en vult `holes_data` aan.

> ⚠️ Zelfde kanttekening als bij GOLF.NL: dit gebruikt je eigen account via een
> onofficiële weg. Garmin vereist vaak **MFA**; daarom log je één keer interactief
> in en gebruikt de geplande job daarna een opgeslagen token.

## 1. Eenmalig inloggen → token

```powershell
cd "C:\Users\mathi\Golf tracker"
pip install -r scripts/requirements.txt
python scripts/garmin_login.py
```

Vul je Garmin-e-mail, wachtwoord en (indien gevraagd) de MFA-code in. Onderaan
print het script een **token-string**. Die zet je als GitHub-secret `GARMIN_TOKEN`
(Settings → Secrets and variables → Actions). Het token wordt automatisch ververst
tot het verloopt (~1 jaar); daarna draai je `garmin_login.py` opnieuw.

## 2. (Optioneel) de parse controleren

De veldnamen zijn al afgestemd op de Garmin Connect golf-API (`scorecardDetails →
scorecard → holes` met `number/strokes/putts/penalties/fairwayShotOutcome`).
Wil je zien wat de sync eruit haalt zonder naar Supabase te schrijven:

```powershell
python scripts/sync_garmin.py --dump
```

Dit print de eerste scorekaart-summary en de geparsede holes. Mocht Garmin de API
ooit wijzigen, geef me dan deze output en ik pas `parse_hole`/`detail_holes` aan.

## 3. Lokaal draaien (schrijft naar Supabase)

```powershell
$env:GARMIN_TOKEN = "het-token-uit-stap-1"
$env:SUPABASE_URL = "https://xxxx.supabase.co"
$env:SUPABASE_ANON_KEY = "eyJ..."
python scripts/sync_garmin.py
```

## 4. Gepland via GitHub Actions

[`.github/workflows/sync-garmin.yml`](../.github/workflows/sync-garmin.yml) draait
dagelijks (iets ná de GOLF.NL-sync) en met een handmatige knop. Benodigde secrets:
`GARMIN_TOKEN`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`.

## Hoe het matcht

- Per Garmin-scorekaart wordt de **speeldatum** gepakt en gezocht naar een GOLF.NL-ronde
  op diezelfde dag. Meerdere rondes op één dag? Dan matcht het op aantal holes.
- Per hole worden **putts, penalties en fairway** ingevuld; **GIR** wordt berekend
  (`(slagen − putts) ≤ (par − 2)`). De app leidt GIR%, fairway%, 3-putts en
  penalties-per-ronde daar automatisch uit af.
- Vindt Garmin een ronde die niet in GOLF.NL staat (bv. een oefenronde), dan wordt
  die overgeslagen — GOLF.NL blijft de bron voor welke rondes bestaan.
