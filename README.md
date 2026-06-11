# ⛳ Golf Progressie Tracker

Een mobiel-vriendelijke webapp om je golfrondes, handicap-progressie en
Garmin-statistieken bij te houden. Frontend draait op **GitHub Pages**,
data wordt opgeslagen in **Supabase** (met automatische lokale fallback).

![Tabs: Overzicht · Rondes · Toevoegen · Grafiek](icon.svg)

## Features

- **Screenshots uploaden + AI-inlezen** — upload je GOLF.NL-schermen (Score +
  Scorecard) en laat Claude (vision) de ronde automatisch uitlezen; jij controleert
  en slaat op. Geen handmatig typen.
- **Rondes invoeren** — datum, baan, holes (9/18), tee, STB, dagresultaat (SD),
  handicap, totaal slagen, baanhandicap
- **Per-hole data** — par, score, fairway, GIR, putts en penalties per hole
- **Garmin / detail-stats per ronde** — putts, penalties, bunkers, bunker saves,
  GIR, fairways, 3-putts, double bogeys
- **Grafieken** — handicap-progressie, Stableford per ronde, en rolling
  10-rondes trend (Chart.js)
- **Statistieken** — beste ronde, gemiddelde score (laatste 20, → 18h), gemiddelde
  STB (9h/18h), totale vooruitgang, laagste dagresultaat, GIR %, fairway %,
  3-putts/ronde, penalties/ronde, double bogey rate, par 3/4/5-scoring,
  Garmin-gemiddelden
- **EXS-detectie** — markeert exceptionele scores (dagresultaat ≥ 7.0 onder je index)
- **Mobiel-first** — gemaakt voor de iPhone, toe te voegen aan je beginscherm (PWA)

---

## 1. Lokaal proberen

Open `index.html` gewoon in je browser. Zonder Supabase-config draait de app
volledig **lokaal** (data in je browser, `localStorage`) en is hij alvast
gevuld met je 10 startrondes. De badge rechtsboven toont dan `● Lokaal`.

> Tip: open via een mini-webserver om module-imports goed te laten werken:
> ```powershell
> python -m http.server 8000
> # of:  npx serve .
> ```
> Daarna: <http://localhost:8000>

---

## 2. Supabase koppelen (data op al je apparaten)

1. Maak gratis een project aan op <https://supabase.com>.
2. Open in je project de **SQL Editor**, plak de inhoud van
   [`supabase/schema.sql`](supabase/schema.sql) en klik **Run**.
   Dit maakt de tabel `rounds`, zet Row Level Security aan en vult je 10 startrondes.
3. Ga naar **Project Settings → API** en kopieer:
   - **Project URL**
   - **anon public** key
4. Vul beide in `js/config.js`:
   ```js
   export const SUPABASE_URL = "https://xxxx.supabase.co";
   export const SUPABASE_ANON_KEY = "eyJhbGciOi...";
   ```
5. Herlaad de app. De badge toont nu `☁ Cloud`.

> **Veiligheid:** de anon-key is bedoeld om publiek in de frontend te staan.
> Beveiliging gebeurt via RLS-policies in de database. Het meegeleverde schema
> geeft de anon-rol volledige toegang tot de `rounds`-tabel — prima voor een
> persoonlijke tracker. Wil je het echt afschermen, voeg dan Supabase Auth toe
> en wijzig de policy naar bv. `auth.uid() = user_id`.

---

## 2b. AI-screenshot inlezen koppelen (optioneel, aanrader)

Hiermee upload je je GOLF.NL-screenshots en vult de app het formulier automatisch.
Dit draait via een **Supabase Edge Function** die Claude (vision) aanroept, zodat je
Anthropic-key veilig op de server staat en niet in de frontend.

Vereist: [Supabase CLI](https://supabase.com/docs/guides/cli) en een
[Anthropic API-key](https://console.anthropic.com/).

```powershell
# eenmalig: koppel je lokale map aan je Supabase-project
supabase login
supabase link --project-ref <jouw-project-ref>

# deploy de functie (zonder JWT-check zodat de anon-frontend 'm mag aanroepen)
supabase functions deploy parse-round --no-verify-jwt

# zet je Anthropic-key als server-secret (komt NIET in de frontend)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

De functie staat dan op `https://<project>.supabase.co/functions/v1/parse-round`
en wordt automatisch gevonden via je `SUPABASE_URL` uit `js/config.js`.

> **Kosten:** elke screenshot-analyse kost een paar centen aan Anthropic-tokens.
> Het model staat in [`supabase/functions/parse-round/index.ts`](supabase/functions/parse-round/index.ts)
> (`MODEL`) — wil je goedkoper, zet dat op bv. `claude-haiku-4-5`.
>
> **Zonder deze functie** werkt de app gewoon: screenshots worden dan alleen als
> bijlage bij de ronde bewaard en vul je de velden zelf in. In lokale modus
> (geen Supabase) is AI-inlezen niet beschikbaar.

---

## 3. Publiceren op GitHub Pages

1. Maak een GitHub-repo en push deze map:
   ```powershell
   git init
   git add .
   git commit -m "Golf progressie tracker"
   git branch -M main
   git remote add origin https://github.com/<jij>/golf-tracker.git
   git push -u origin main
   ```
2. Repo → **Settings → Pages** → Source: **Deploy from a branch** →
   Branch: `main` / `/ (root)` → **Save**.
3. Na ~1 minuut staat de app op
   `https://<jij>.github.io/golf-tracker/`.
4. Open die URL op je iPhone → deel-knop → **Zet op beginscherm** voor een
   app-achtige ervaring (fullscreen, eigen icoon).

> `js/config.js` met je anon-key wordt mee gepusht — dat is by design veilig
> (zie hierboven). Wil je 'm tóch niet in een publieke repo, maak de repo dan privé;
> GitHub Pages werkt ook met private repos op betaalde plannen.

---

## Bestandsstructuur

```
index.html              # markup + tab-navigatie
icon.svg                # app-icoon (PWA + favicon)
manifest.webmanifest    # PWA-manifest
css/styles.css          # mobiel-first styling, golf-thema
js/config.js            # ← hier zet je je Supabase-credentials
js/db.js                # datalaag (Supabase óf localStorage), screenshots, AI-call
js/stats.js             # statistieken + EXS-detectie + per-hole afgeleiden
js/charts.js            # Chart.js grafieken (hcp, STB, rolling trend)
js/app.js               # UI, routing, formulier, screenshot-flow
supabase/schema.sql     # databasetabel + RLS + storage-bucket + startdata
supabase/functions/parse-round/index.ts   # Edge Function: Claude leest screenshots
```

## Hoe EXS wordt bepaald

Volgens de WHS-logica telt een ronde als **exceptionele score** wanneer het
dagresultaat (Score Differential) minstens **7,0** lager is dan je
handicap-index van vóór die ronde. De app berekent dit automatisch en toont
een `EXS`-badge bij de betreffende ronde plus een overzicht op het dashboard.
