# GOLF.NL automatisch synchroniseren

De scraper ([`scripts/sync_golfnl.py`](../scripts/sync_golfnl.py)) logt in op
mijn.golf.nl, leest je scores-overzicht uit en schrijft nieuwe rondes naar je
Supabase-tabel `rounds`. De app toont ze dan automatisch.

> ⚠️ Dit logt automatisch in op je eigen account en gaat in tegen de
> voorwaarden van GOLF.NL (eigen data, klein risico). Werkt alleen zonder 2FA.

## Wat er wordt opgehaald

Per ronde uit het overzicht: datum, baan, tee, STB, dagresultaat (SD), handicap,
totaal slagen, baanhandicap, en of de ronde qualifying was. Voor elke **nieuwe**
ronde wordt daarna de scorekaart-detailpagina opgehaald voor de **definitieve
holes-telling (9/18)** en **par + score per hole** (`holes_data`). Daaruit berekent
de app je par-3/4/5-scoring en double bogey rate.

- **GIR / fairway / putts / penalties per hole** staan níét op de GOLF.NL-website
  (die kwamen uit de Garmin-sync in de app). Die blijven leeg bij het scrapen — vul
  ze desgewenst via een screenshot of het handmatige raster.
- Detail ophalen kan uit met `FETCH_DETAILS = False` boven in `sync_golfnl.py`
  (dan worden holes afgeleid uit het aantal slagen: ≥ 70 = 18 holes).
- De scraper ontdubbelt op **datum + holes + dagresultaat**, dus je kunt 'm zo vaak
  draaien als je wil; alleen nieuwe rondes worden toegevoegd.

## 1. Lokaal testen (geen login nodig)

Sla je scores-HTML op (zie onderaan) en draai een "dry run" — die parseert alleen
en print het resultaat:

```powershell
cd "C:\Users\mathi\Golf tracker"
pip install -r scripts/requirements.txt
python scripts/sync_golfnl.py pad\naar\scores-data.html
```

## 2. Lokaal écht draaien (schrijft naar Supabase)

```powershell
$env:GOLFNL_USERNAME = "jouw@email.nl"
$env:GOLFNL_PASSWORD = "je-wachtwoord"
$env:SUPABASE_URL = "https://xxxx.supabase.co"
$env:SUPABASE_SERVICE_KEY = "eyJ...service_role..."   # Settings -> API -> service_role
$env:GOLF_USER_ID = "jouw-auth-user-uid"              # Authentication -> Users -> User UID
python scripts/sync_golfnl.py
```

> De sync schrijft met de **service_role**-key (omzeilt RLS) en koppelt rondes aan
> `GOLF_USER_ID`. De anon-key kan door de login-beveiliging niet meer schrijven.

## 3. Gepland via GitHub Actions

De workflow [`.github/workflows/sync-golfnl.yml`](../.github/workflows/sync-golfnl.yml)
draait elke dag (en met een handmatige knop).

1. GitHub → repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - `GOLFNL_USERNAME` · `GOLFNL_PASSWORD`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY` (de service_role-key — server-side, nooit in de frontend)
   - `GOLF_USER_ID` (je auth User UID)
2. Tabblad **Actions** → **Sync GOLF.NL** → **Run workflow** om te testen.

## Als het misgaat

- **403 / CloudFront**: GOLF.NL's firewall blokkeert mogelijk GitHub Actions
  (datacenter-IP) of het `requests`-verkeer. Draai 'm dan lokaal (stap 2) vanaf
  je thuis-IP, of we stappen over op een echte-browser-variant (Playwright).
- **Teruggestuurd naar /login**: controleer `GOLFNL_USERNAME`/`PASSWORD`, of er
  staat 2FA aan.

## De scores-HTML opslaan (voor de dry run)

1. Ga ingelogd naar <https://mijn.golf.nl/mijn-spel/scores> en wacht tot je rondes zichtbaar zijn.
2. **F12 → Console**, plak en Enter:
   ```js
   copy(document.querySelector('.PartialContent').innerHTML)
   ```
3. Plak in Kladblok, sla op als `scores-data.html`.
