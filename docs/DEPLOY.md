# Uitrol-stappenplan — GitHub Pages + Supabase (met login)

De app is **privé met login**: elke gebruiker ziet alleen z'n eigen rondes.
De site is publiek bereikbaar, maar zonder inloggen zie/wijzig je niets.

Volg de fases in volgorde. **Kern** = fase 1–6 (werkende, beveiligde app).
**Optioneel** = fase 7–10 (AI-screenshots, auto-sync).

---

## Fase 1 — Supabase project + database

1. <https://supabase.com> → **New project** (`golf-tracker`, region Frankfurt,
   wachtwoord bewaren). Wacht ~2 min.
2. **SQL Editor** → **+ New query** → plak heel [`supabase/schema.sql`](../supabase/schema.sql) → **Run**.
3. Nieuwe query → plak heel [`supabase/auth.sql`](../supabase/auth.sql) → **Run**.
   (Zet per-gebruiker beveiliging aan en maakt screenshots privé.)
4. ⚙️ **Project Settings → API** → kopieer en bewaar:
   - **Project URL** (`https://abcxyz.supabase.co`)
   - **anon `public`** key → voor de frontend (mag publiek)
   - **`service_role`** key → **alleen** voor GitHub Actions (NOOIT in de frontend!)

---

## Fase 2 — Login instellen + jouw account

1. **Authentication → Providers → Email**: zet **Enable** aan. Zet
   **"Confirm email"** uit (handiger voor een persoonlijk account).
2. **Authentication → Users → Add user → Create new user**: vul je e-mail +
   wachtwoord in (dit is je login voor de app).
3. **Signups uitzetten** zodat niemand anders een account maakt:
   **Authentication → Providers → Email → "Allow new users to sign up"** uit.
   (Wil je later vrienden toevoegen: zet dit weer aan, of voeg ze handmatig toe
   via *Add user*. Ieder krijgt automatisch z'n eigen afgeschermde data.)
4. Pak je **User UID**: **Authentication → Users** → klik je gebruiker → kopieer
   **User UID** (een uuid). Die heb je straks nodig als `GOLF_USER_ID`, en om je
   bestaande startdata te claimen:
   - **SQL Editor** → `update public.rounds set user_id = 'JOUW-USER-UID' where user_id is null;` → **Run**.
   - (Of laat de startdata weg en laat de GOLF.NL-sync 'm vullen.)

---

## Fase 3 — App configureren

Vul in [`js/config.js`](../js/config.js) je Project URL + de **anon** key
(niet de service_role!):
```js
export const SUPABASE_URL = "https://abcxyz.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOi...anon...";
```

---

## Fase 4 — Naar GitHub (doet Claude, of zelf)

De repo staat al op `https://github.com/<jouwnaam>/golf-tracker`. Na wijzigingen
aan `config.js` push je opnieuw:
```powershell
cd "C:\Users\mathi\Golf tracker"
git add -A; git commit -m "config + beveiliging"; git push
```
(Of laat Claude het pushen.)

---

## Fase 5 — GitHub Pages

Repo → **Settings → Pages** → Source *Deploy from a branch*, Branch `main` / root
→ **Save**. Na ~1 min: `https://<jouwnaam>.github.io/golf-tracker/`.

---

## Fase 6 — Op je iPhone

Open de Pages-URL in Safari → je krijgt het **inlogscherm** → log in met je
account uit fase 2. Daarna deel-knop → **Zet op beginscherm**. ✅ Beveiligde
app, klaar voor gebruik.

---

## Fase 7 — AI-screenshots (optioneel)

1. Supabase → **Edge Functions → Create a function** → naam `parse-round` →
   plak heel [`supabase/functions/parse-round/index.ts`](../supabase/functions/parse-round/index.ts).
   **Laat "Verify JWT" AAN** (zo kan alleen een ingelogde gebruiker de functie
   aanroepen — geen misbruik van je Anthropic-tegoed). **Deploy**.
2. **Edge Functions → Secrets** → `ANTHROPIC_API_KEY` = `sk-ant-...`.
3. Herlaad de app → bij "Ronde toevoegen" verschijnt **✨ Lees screenshots met AI**.

---

## Fase 8 — Auto-sync GOLF.NL (optioneel)

Repo → **Settings → Secrets and variables → Actions → New repository secret**:
- `GOLFNL_USERNAME`, `GOLFNL_PASSWORD` — je GOLF.NL-login
- `SUPABASE_URL` — Project URL
- `SUPABASE_SERVICE_KEY` — de **service_role** key (server-side, omzeilt RLS)
- `GOLF_USER_ID` — je User UID uit fase 2

Dan **Actions → Sync GOLF.NL → Run workflow** om te testen.

---

## Fase 9 — Auto-sync Garmin (optioneel)

1. Lokaal: `pip install -r scripts/requirements.txt` → `python scripts/garmin_login.py`
   → kopieer het token.
2. Actions-secret `GARMIN_TOKEN` = dat token. (`SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY`, `GOLF_USER_ID` heb je al uit fase 8.)
3. **Actions → Sync Garmin → Run workflow**.

---

## Fase 10 — Foutmeldingen per e-mail

GitHub → avatar → **Settings → Notifications → Actions** → "Send notifications
for failed workflows only" aanvinken.

---

## Waar elke sleutel hoort

| Waar | Sleutel | Welke |
|---|---|---|
| `js/config.js` (publiek) | SUPABASE_URL, SUPABASE_ANON_KEY | URL + **anon** |
| Supabase → Edge Functions → Secrets | ANTHROPIC_API_KEY | `sk-ant-...` |
| GitHub → Actions secrets | SUPABASE_URL, **SUPABASE_SERVICE_KEY**, GOLF_USER_ID | URL + **service_role** + je UID |
| GitHub → Actions secrets | GOLFNL_USERNAME, GOLFNL_PASSWORD, GARMIN_TOKEN | logins |

> 🔑 **service_role-key**: geeft volledige DB-toegang. Staat veilig in GitHub
> Actions-secrets (versleuteld, niet zichtbaar in logs, niet beschikbaar voor
> fork-PR's). Zet 'm **nooit** in `js/config.js` of ergens in de frontend.

## Vrienden toevoegen (later)

Werkt het goed en wil je vrienden laten meedoen? Zet signups aan (fase 2.3) of
voeg ze toe via **Add user**. Door de per-gebruiker RLS ziet ieder alleen z'n
eigen rondes. Willen zij ook auto-sync? Dan draait ieder z'n eigen sync met
*hun* `GOLF_USER_ID` + GOLF.NL/Garmin-login (bv. een eigen fork of extra workflow).

## Snelle probleemoplossing

- Inlogscherm blijft komen → verkeerd wachtwoord, of account niet aangemaakt (fase 2).
- "Lokaal" i.p.v. inlogscherm → `config.js` niet (goed) ingevuld/gepusht.
- Sync rood: **"new row violates row-level security"** → `GOLF_USER_ID` ontbreekt
  of de `SUPABASE_SERVICE_KEY` is per ongeluk de anon-key.
- AI-knop fout → `ANTHROPIC_API_KEY` mist, of je bent niet ingelogd (Verify JWT).
