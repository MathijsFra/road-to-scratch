# Uitrol-stappenplan — GitHub Pages + Supabase

Volg de fases in volgorde. De **kern** (fase 1–5) zet de werkende app online.
Fase 6–9 voegen de optionele lagen toe (AI-screenshots, auto-sync). Je kunt na
elke fase stoppen en later verder.

Benodigd: een GitHub-account, een Supabase-account, en (voor de sync-lagen)
Python — die heb je al, want de scripts draaiden lokaal.

---

## Fase 1 — Supabase database

1. Ga naar <https://supabase.com> → **Start your project** → log in.
2. **New project**: naam `golf-tracker`, kies een database-wachtwoord (bewaren),
   region **Central EU (Frankfurt)**. Klik **Create** en wacht ~2 min.
3. Links **SQL Editor** → **+ New query**. Open [`supabase/schema.sql`](../supabase/schema.sql),
   kopieer **alles**, plak, klik **Run**. → maakt de tabel `rounds`, RLS, de
   storage-bucket `round-screenshots`, en je 10 startrondes. Je ziet "Success".
4. ⚙️ **Project Settings → API**. Kopieer:
   - **Project URL** (bv. `https://abcxyz.supabase.co`)
   - **anon `public`** key (lange `eyJ…`-string)

---

## Fase 2 — App configureren

1. Open [`js/config.js`](../js/config.js) en vul je twee waarden in:
   ```js
   export const SUPABASE_URL = "https://abcxyz.supabase.co";
   export const SUPABASE_ANON_KEY = "eyJhbGciOi...";
   ```
2. Bewaar. (De anon-key hoort publiek te zijn; beveiliging zit in de RLS uit fase 1.)

---

## Fase 3 — Naar GitHub pushen

**Optie A — via de website (geen git nodig):**
1. <https://github.com> → **+** → **New repository** → naam `golf-tracker` →
   **Public** → **Create repository**.
2. Op de lege repo: **uploading an existing file** → sleep **de hele inhoud** van
   `C:\Users\mathi\Golf tracker` erin (incl. mappen `css`, `js`, `supabase`,
   `scripts`, `docs`, `.github`) → **Commit changes**.

**Optie B — via PowerShell (git):**
```powershell
cd "C:\Users\mathi\Golf tracker"
git init
git add .
git commit -m "Golf progressie tracker"
git branch -M main
git remote add origin https://github.com/<jouwnaam>/golf-tracker.git
git push -u origin main
```

> ⚠️ **Let op (publieke repo, geen login):** de app heeft geen gebruikersaccount.
> Iedereen die je Pages-URL én de anon-key kent, kan via de RLS-policy je rondes
> lezen/wijzigen. Voor een persoonlijke tracker met een obscure URL is dat meestal
> prima. Wil je het echt afschermen, dan voegen we later Supabase Auth toe.

---

## Fase 4 — GitHub Pages aanzetten

1. Repo → **Settings** → links **Pages**.
2. **Source**: *Deploy from a branch* · **Branch**: `main` · map `/ (root)` → **Save**.
3. Na ~1 min staat de app op `https://<jouwnaam>.github.io/golf-tracker/`.
   Open die URL → badge rechtsboven hoort **☁ Cloud** te tonen.

---

## Fase 5 — Op je iPhone (PWA)

1. Open de Pages-URL in **Safari**.
2. Deel-knop → **Zet op beginscherm**. Je krijgt een app-icoon en fullscreen.

> **Tot hier heb je een volledig werkende app**: handmatig rondes invoeren (incl.
> per-hole raster) en alles synct via Supabase op al je apparaten. De rest is extra.

---

## Fase 6 — AI-screenshots (optioneel)

Laat Claude je GOLF.NL-screenshots uitlezen. Vereist een
[Anthropic API-key](https://console.anthropic.com) (kost een paar cent per ronde).

1. **Edge Function deployen — via het dashboard (geen installatie):**
   - Supabase → links **Edge Functions** → **Create a function** (via editor).
   - Naam: `parse-round`. Wis de voorbeeldcode, plak de **hele** inhoud van
     [`supabase/functions/parse-round/index.ts`](../supabase/functions/parse-round/index.ts).
   - Zet **Verify JWT** / "Enforce JWT" **uit** in de functie-instellingen.
   - **Deploy**.
   - **Edge Functions → Secrets** → **Add new secret**:
     `ANTHROPIC_API_KEY` = `sk-ant-...` → **Save**.

   *Alternatief via CLI:* `supabase functions deploy parse-round --no-verify-jwt`
   en `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`

2. Herlaad de app → bij "Ronde toevoegen" verschijnt de knop **✨ Lees screenshots met AI**.

---

## Fase 7 — Automatische GOLF.NL-sync (optioneel)

1. Repo → **Settings → Secrets and variables → Actions → New repository secret**.
   Maak deze vier:
   - `GOLFNL_USERNAME` = je GOLF.NL e-mail
   - `GOLFNL_PASSWORD` = je GOLF.NL-wachtwoord
   - `SUPABASE_URL` = zelfde als in config.js
   - `SUPABASE_ANON_KEY` = zelfde als in config.js
2. Tabblad **Actions** → workflow **Sync GOLF.NL** → **Run workflow** (test).
   Daarna draait hij elke dag automatisch.

---

## Fase 8 — Automatische Garmin-sync (optioneel)

1. **Token minten** (eenmalig, lokaal):
   ```powershell
   cd "C:\Users\mathi\Golf tracker"
   pip install -r scripts/requirements.txt
   python scripts/garmin_login.py
   ```
   Vul e-mail/wachtwoord/MFA in → kopieer de geprinte token-string.
2. Repo → **Settings → Secrets and variables → Actions** → secret
   `GARMIN_TOKEN` = die token-string. (`SUPABASE_URL`/`SUPABASE_ANON_KEY` heb je al uit fase 7.)
3. **Actions** → **Sync Garmin** → **Run workflow** (test).
   Draait dagelijks net ná de GOLF.NL-sync.

---

## Fase 9 — Foutmeldingen per e-mail

GitHub → avatar → **Settings → Notifications → Actions** → vink
**"Send notifications for failed workflows only"** aan. Bij een rode (mislukte)
sync krijg je dan automatisch mail.

---

## Volgorde-overzicht van secrets

| Waar | Secret | Waarde |
|---|---|---|
| `js/config.js` (in repo, publiek) | SUPABASE_URL, SUPABASE_ANON_KEY | Project URL + anon key |
| Supabase → Edge Functions → Secrets | ANTHROPIC_API_KEY | `sk-ant-...` |
| GitHub → Actions secrets | GOLFNL_USERNAME, GOLFNL_PASSWORD | GOLF.NL-login |
| GitHub → Actions secrets | GARMIN_TOKEN | uit `garmin_login.py` |
| GitHub → Actions secrets | SUPABASE_URL, SUPABASE_ANON_KEY | zelfde als config.js |

## Snelle probleemoplossing

- Badge blijft **● Lokaal** → `config.js` niet (goed) ingevuld of niet ge-her-upload.
- AI-knop doet niets → `ANTHROPIC_API_KEY`-secret mist of *Verify JWT* staat nog aan.
- Sync rood (Actions) → open de run-log; check de secrets en (bij Garmin) of het
  token nog geldig is / 2FA. CloudFront-403 bij GOLF.NL → draai die sync lokaal.
- Witte pagina → open via de Pages-URL, niet door `index.html` lokaal te dubbelklikken.
