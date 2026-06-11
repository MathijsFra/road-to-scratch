#!/usr/bin/env python3
"""
Sync Garmin Connect shot-stats -> Supabase, gekoppeld aan je GOLF.NL-rondes.

GOLF.NL levert datum/baan/score/par-per-hole; Garmin levert de shot-stats
(putts, fairways, penalties). Dit script haalt je Garmin-scorekaarten op,
matcht ze op datum aan de rondes in Supabase, en vult per hole putts/fairway/
penalties aan in `holes_data`. GIR wordt zelf berekend uit par en (slagen - putts).

Vereiste environment variables:
  GARMIN_TOKEN                       - token-string uit garmin_login.py
    (of GARMINTOKENS = pad naar ~/.garminconnect, of GARMIN_EMAIL/GARMIN_PASSWORD)
  SUPABASE_URL, SUPABASE_ANON_KEY    - zelfde als in js/config.js

Dump de ruwe Garmin-JSON (om veldnamen te controleren), zonder Supabase:
    python scripts/sync_garmin.py --dump
"""

import os
import sys
import json
import datetime as dt
from garminconnect import Garmin

from golfutil import setup_logging, require_env, request_with_retry, retry_call, run_main

log = setup_logging("garmin")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")


# ============================================================
#  Garmin: inloggen + scorekaarten ophalen
# ============================================================
def garmin_auth() -> Garmin:
    # login(tokenstore=...) accepteert zowel een token-string (lang) als een map.
    token = (os.environ.get("GARMIN_TOKEN") or "").strip()
    if token:
        try:
            g = Garmin()
            g.login(tokenstore=token)     # token-string uit garmin_login.py
            return g
        except Exception as e:  # noqa: BLE001
            log.warning("GARMIN_TOKEN werkte niet (%s); val terug op GARMINTOKENS/credentials.", e)

    tokenstore = os.environ.get("GARMINTOKENS")
    if tokenstore:
        g = Garmin()
        g.login(tokenstore=tokenstore)   # map met opgeslagen token
        return g

    email = os.environ.get("GARMIN_EMAIL")
    password = os.environ.get("GARMIN_PASSWORD")
    if email and password:
        g = Garmin(email=email, password=password)
        g.login()
        return g

    log.error("Geen Garmin-credentials. Draai garmin_login.py en zet GARMIN_TOKEN of GARMINTOKENS.")
    sys.exit(2)


def as_list(data) -> list:
    """Garmin geeft soms een lijst, soms een dict met de lijst onder een sleutel."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("scorecardSummaries", "scorecards", "summaries", "data"):
            if isinstance(data.get(key), list):
                return data[key]
        # anders: eerste list-waarde
        for v in data.values():
            if isinstance(v, list):
                return v
    return []


def pick(d: dict, *keys):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d[k]
    return None


def scorecard_date(summary: dict) -> str | None:
    """Pakt de speeldatum (yyyy-mm-dd) uit een scorekaart-summary."""
    raw = pick(summary, "startTime", "scorecardStartTime", "playedTime",
               "scorecardDate", "startDate", "date")
    if raw is None:
        return None
    s = str(raw)
    # epoch milliseconden?
    if s.isdigit():
        ts = int(s)
        if ts > 10_000_000_000:
            ts //= 1000
        return dt.datetime.utcfromtimestamp(ts).date().isoformat()
    return s[:10]   # ISO-string


def scorecard_id(summary: dict):
    return pick(summary, "id", "scorecardId", "scorecardInternalId", "scoreCardId")


# ============================================================
#  Per-hole stats uit een Garmin scorekaart-detail
# ============================================================
FAIRWAY_MAP = {
    "HIT": "hit", "FAIRWAY": "hit",
    "LEFT": "left", "MISSED_LEFT": "left",
    "RIGHT": "right", "MISSED_RIGHT": "right",
    "SHORT": "miss", "LONG": "miss", "MISSED": "miss", "MISS": "miss",
}


def detail_holes(detail) -> list[dict]:
    """Holes zitten in scorecardDetails[0].scorecard.holes."""
    if isinstance(detail, dict):
        sd = detail.get("scorecardDetails")
        if isinstance(sd, list) and sd:
            holes = sd[0].get("scorecard", {}).get("holes")
            if isinstance(holes, list):
                return holes
    return []


def parse_hole(h: dict) -> dict:
    """Garmin-hole -> {hole, putts, penalties, fairway}. GIR berekenen we later."""
    number = pick(h, "number", "holeNumber", "hole")
    putts = pick(h, "putts", "puttCount", "numberOfPutts")
    penalties = pick(h, "penalties", "penaltyStrokes", "penaltyCount")
    fairway_raw = pick(h, "fairwayShotOutcome", "fairwayShot", "fairway", "teeShotOutcome")
    fairway = FAIRWAY_MAP.get(str(fairway_raw).upper()) if fairway_raw is not None else None
    return {
        "hole": to_int(number),
        "putts": to_int(putts),
        "penalties": to_int(penalties),
        "fairway": fairway,
    }


def to_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


# ============================================================
#  Supabase: rondes ophalen + bijwerken
# ============================================================
def sb_headers() -> dict:
    return {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
        "Content-Type": "application/json",
    }


def sb_get_rounds() -> list[dict]:
    r = request_with_retry(
        "GET", f"{SUPABASE_URL}/rest/v1/rounds?select=id,date,holes,holes_data",
        headers=sb_headers(),
    )
    return r.json()


def sb_patch_round(round_id: str, patch: dict) -> None:
    request_with_retry(
        "PATCH", f"{SUPABASE_URL}/rest/v1/rounds?id=eq.{round_id}",
        headers={**sb_headers(), "Prefer": "return=minimal"},
        data=json.dumps(patch),
    )


def merge_into_holes(existing: list, garmin_holes: list[dict]) -> list:
    """Voegt putts/penalties/fairway/gir per hole toe aan de bestaande holes_data
    (par/score komen van GOLF.NL). GIR = (slagen - putts) <= (par - 2)."""
    by_num = {g["hole"]: g for g in garmin_holes if g.get("hole") is not None}
    existing = existing or []

    # Als GOLF.NL geen per-hole had: bouw vanaf Garmin (par/score onbekend).
    if not existing:
        existing = [{"hole": g["hole"], "par": None, "score": None,
                     "fairway": None, "gir": None, "putts": None, "penalties": None}
                    for g in garmin_holes if g.get("hole") is not None]

    out = []
    for h in existing:
        g = by_num.get(h.get("hole"))
        merged = dict(h)
        if g:
            if g.get("putts") is not None:
                merged["putts"] = g["putts"]
            if g.get("penalties") is not None:
                merged["penalties"] = g["penalties"]
            if g.get("fairway") is not None and h.get("par") != 3:
                merged["fairway"] = g["fairway"]
            # GIR zelf berekenen als we par, score en putts hebben.
            par, score, putts = h.get("par"), h.get("score"), g.get("putts")
            if par is not None and score is not None and putts is not None:
                merged["gir"] = (score - putts) <= (par - 2)
        out.append(merged)
    return out


# ============================================================
#  main
# ============================================================
def main() -> None:
    dump = "--dump" in sys.argv

    log.info("Inloggen op Garmin Connect…")
    g = garmin_auth()

    summaries = as_list(retry_call(g.get_golf_summary, limit=200))
    log.info("%d Garmin-scorekaart(en) gevonden.", len(summaries))

    if dump:
        print("\n=== RUWE SUMMARY (eerste scorekaart) ===")
        print(json.dumps(summaries[0] if summaries else {}, indent=2, ensure_ascii=False)[:4000])
        if summaries:
            sid = scorecard_id(summaries[0])
            print(f"\n(scorecard_id = {sid})")
            print("\n=== GEPARSEDE HOLES (zo gebruikt de sync ze) ===")
            holes = [parse_hole(h) for h in detail_holes(retry_call(g.get_golf_scorecard, sid))]
            print(json.dumps(holes, indent=2, ensure_ascii=False))
        return

    require_env("SUPABASE_URL", "SUPABASE_ANON_KEY")

    rounds = sb_get_rounds()
    by_date: dict[str, list] = {}
    for r in rounds:
        by_date.setdefault(r["date"], []).append(r)
    log.info("%d ronde(s) in Supabase om op te matchen.", len(rounds))

    updated, failed = 0, 0
    for s in summaries:
        date = scorecard_date(s)
        candidates = by_date.get(date or "", [])
        if not candidates:
            continue   # geen GOLF.NL-ronde op die dag

        # Eén kapotte scorekaart mag de hele run niet stoppen.
        try:
            detail = retry_call(g.get_golf_scorecard, scorecard_id(s))
            garmin_holes = [parse_hole(h) for h in detail_holes(detail)]
        except Exception as e:  # noqa: BLE001
            failed += 1
            log.warning("Scorekaart %s (%s) overgeslagen: %s", scorecard_id(s), date, e)
            continue

        if not any(h.get("putts") is not None or h.get("fairway") or h.get("penalties") is not None
                   for h in garmin_holes):
            continue   # niets bruikbaars

        # Als er meerdere rondes op die dag zijn: match op holes-aantal.
        target = candidates[0]
        if len(candidates) > 1:
            target = next((c for c in candidates if c.get("holes") == len(garmin_holes)), candidates[0])

        try:
            merged = merge_into_holes(target.get("holes_data"), garmin_holes)
            sb_patch_round(target["id"], {"holes_data": merged})
            updated += 1
            log.info("✓ %s: shot-stats toegevoegd (%d holes)", date, len(garmin_holes))
        except Exception as e:  # noqa: BLE001
            failed += 1
            log.warning("Bijwerken van ronde %s (%s) mislukt: %s", target.get("id"), date, e)

    log.info("Klaar. %d ronde(s) bijgewerkt, %d overgeslagen door fouten.", updated, failed)
    if updated == 0 and failed > 0:
        sys.exit(1)   # alles faalde -> laat de scheduled run rood worden


if __name__ == "__main__":
    run_main(main)
