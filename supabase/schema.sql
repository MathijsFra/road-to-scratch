-- ============================================================
--  Golf Progressie Tracker — Supabase schema
--  Plak dit volledig in de Supabase SQL Editor en klik "Run".
-- ============================================================

create table if not exists public.rounds (
  id              uuid primary key default gen_random_uuid(),
  date            date    not null,
  course          text    not null,
  holes           int     not null check (holes in (9, 18)),
  tee             text,
  stb             int,                 -- Stableford punten
  sd              numeric(4,1),        -- Score Differential / dagresultaat
  hcp             numeric(4,1),        -- Handicap index na de ronde
  score           int,                 -- Totaal aantal slagen
  course_handicap int,                 -- Baanhandicap (playing handicap)
  putts           int,
  penalties       int,
  bunkers         int,
  bunker_saves    int,
  gir             int,                 -- aantal greens in regulation
  fairways_hit    int,
  fairways_total  int,
  three_putts     int,
  double_bogeys   int,
  holes_data      jsonb   not null default '[]'::jsonb,  -- per-hole: par/score/fairway/gir/putts/penalties
  screenshots     jsonb   not null default '[]'::jsonb,  -- publieke URLs van geüploade screenshots
  notes           text,
  created_at      timestamptz not null default now()
);

create index if not exists rounds_date_idx on public.rounds (date);

-- Bestaande tabel uitbreiden (veilig opnieuw te draaien).
alter table public.rounds
  add column if not exists score           int,
  add column if not exists course_handicap int,
  add column if not exists gir             int,
  add column if not exists fairways_hit    int,
  add column if not exists fairways_total  int,
  add column if not exists three_putts     int,
  add column if not exists double_bogeys   int,
  add column if not exists holes_data      jsonb not null default '[]'::jsonb,
  add column if not exists screenshots     jsonb not null default '[]'::jsonb;

-- ------------------------------------------------------------
--  Row Level Security — persoonlijke app zonder login.
-- ------------------------------------------------------------
alter table public.rounds enable row level security;

drop policy if exists "anon full access" on public.rounds;
create policy "anon full access"
  on public.rounds
  for all
  to anon
  using (true)
  with check (true);

-- ------------------------------------------------------------
--  Storage bucket voor screenshots (publiek leesbaar).
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('round-screenshots', 'round-screenshots', true)
on conflict (id) do nothing;

drop policy if exists "anon upload screenshots" on storage.objects;
create policy "anon upload screenshots"
  on storage.objects
  for insert
  to anon
  with check (bucket_id = 'round-screenshots');

drop policy if exists "anon read screenshots" on storage.objects;
create policy "anon read screenshots"
  on storage.objects
  for select
  to anon
  using (bucket_id = 'round-screenshots');

-- ------------------------------------------------------------
--  Startdata — de 10 bekende rondes.
--  (Wordt overgeslagen als de tabel al rijen bevat.)
-- ------------------------------------------------------------
insert into public.rounds (date, course, holes, tee, stb, sd, hcp)
select * from (values
  ('2025-11-07'::date, 'Zeewolde',         18, 'Geel', 35, 49.6, 47.6),
  ('2025-12-30'::date, 'Harderwold',        9, 'Geel', 21, 45.5, 43.5),
  ('2026-03-14'::date, 'Zeewolde',          9, 'Geel', 20, 42.7, 41.7),
  ('2026-04-25'::date, 'Zeewolde',         18, 'Rood', 36, 42.7, 42.7),
  ('2026-05-01'::date, 'De Scherpenbergh',  9, 'Rood', 18, 44.6, 41.7),
  ('2026-05-03'::date, 'Zeewolde',          9, 'Geel', 22, 39.3, 41.0),
  ('2026-05-08'::date, 'Zeewolde',          9, 'Geel', 21, 38.9, 39.1),
  ('2026-05-22'::date, 'Zeewolde',          9, 'Rood', 22, 37.4, 38.5),
  ('2026-05-29'::date, 'Putten',            9, 'Geel', 20, 38.2, 38.2),
  ('2026-06-04'::date, 'De Kroonprins',    18, 'Geel', 45, 30.1, 34.2)
) as v(date, course, holes, tee, stb, sd, hcp)
where not exists (select 1 from public.rounds);
