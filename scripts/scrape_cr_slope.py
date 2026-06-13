#!/usr/bin/env python3
"""
Backfill CR/slope vanuit golf.nl scorekaart-pagina's.

Zoekt rondes met een gekoppelde tee zonder course_rating of slope_rating,
logt in op golf.nl, herhaalt de scorekaart-HTML en slaat de gevonden
CR/slope op in de course_tees-tabel.

Gebruik:
  python scripts/scrape_cr_slope.py

Env vars:
  SUPABASE_URL, SUPABASE_SERVICE_KEY  — database
  GOLF_USER_ID                        — optioneel: beperkt tot één account
  LOG_LEVEL=DEBUG                     — uitgebreide output
"""

import json
import os
import sys
import time

import requests

from golfutil import run_main, require_env, setup_logging
import sync_golfnl as _gn
from sync_golfnl import (
    golfnl_login,
    golfnl_fetch_scorecard,
    sb_get_user_settings,
    supabase_headers,
    SUPABASE_URL,
    UA,
)

log = setup_logging("scrape_cr_slope")

GOLF_USER_ID = os.environ.get("GOLF_USER_ID", "")


# ---------------------------------------------------------------------------
# Supabase helpers
# ---------------------------------------------------------------------------

def sb_get(path: str, params: str = "") -> list[dict]:
    url = f"{SUPABASE_URL}/rest/v1/{path}{params}"
    resp = requests.get(url, headers=supabase_headers(), timeout=20)
    resp.raise_for_status()
    return resp.json()


def sb_patch(path: str, body: dict) -> None:
    resp = requests.patch(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={**supabase_headers(), "Prefer": "return=minimal"},
        data=json.dumps(body),
        timeout=15,
    )
    resp.raise_for_status()


# ---------------------------------------------------------------------------
# Kern logica
# ---------------------------------------------------------------------------

def get_rounds_missing_cr_slope(user_id: str) -> list[dict]:
    """Rondes met scorecard_id + course_tee_id maar zonder CR/slope in de tee."""
    rounds = sb_get(
        "rounds",
        f"?select=id,golfnl_scorecard_id,course_tee_id,course,tee"
        f"&golfnl_scorecard_id=not.is.null"
        f"&course_tee_id=not.is.null"
        f"&user_id=eq.{user_id}"
        f"&deleted_at=is.null",
    )
    if not rounds:
        return []

    tee_ids = list({r["course_tee_id"] for r in rounds if r.get("course_tee_id")})
    if not tee_ids:
        return []

    ids_csv = ",".join(tee_ids)
    tees = sb_get("course_tees", f"?id=in.({ids_csv})&select=id,course_rating,slope_rating")
    tees_by_id = {t["id"]: t for t in tees}

    missing = []
    for r in rounds:
        tee = tees_by_id.get(r.get("course_tee_id"))
        if tee and (tee.get("course_rating") is None or tee.get("slope_rating") is None):
            r["_tee_id"] = tee["id"]
            missing.append(r)

    log.info(
        "Gebruiker %s: %d ronde(s) met ontbrekende CR/slope (van %d totaal).",
        user_id, len(missing), len(rounds),
    )
    return missing


def update_course_tee(tee_id: str, course_rating, slope_rating) -> bool:
    patch = {}
    if course_rating is not None:
        patch["course_rating"] = course_rating
    if slope_rating is not None:
        patch["slope_rating"] = slope_rating
    if not patch:
        return False
    sb_patch(f"course_tees?id=eq.{tee_id}", patch)
    return True


def backfill_one_user(username: str, password: str, user_id: str) -> tuple[int, int]:
    """Backfill CR/slope voor één gebruiker. Geeft (bijgewerkt, mislukt) terug."""
    _gn.GOLFNL_USERNAME = username
    _gn.GOLFNL_PASSWORD = password

    missing = get_rounds_missing_cr_slope(user_id)
    if not missing:
        log.info("Geen rondes met ontbrekende CR/slope voor gebruiker %s.", user_id)
        return 0, 0

    session = requests.Session()
    session.headers.update({"User-Agent": UA})
    log.info("Inloggen op golf.nl voor gebruiker %s…", user_id)
    golfnl_login(session)

    seen_tees: set[str] = set()
    updated = failed = 0

    for r in missing:
        tee_id = r["_tee_id"]
        if tee_id in seen_tees:
            continue

        scorecard_id = r.get("golfnl_scorecard_id")
        try:
            d = golfnl_fetch_scorecard(session, scorecard_id)
            cr = d.get("course_rating")
            slope = d.get("slope_rating")
            log.debug(
                "Scorekaart %s (%s %s): CR=%s Slope=%s",
                scorecard_id, r.get("course"), r.get("tee"), cr, slope,
            )
            if cr is not None or slope is not None:
                update_course_tee(tee_id, cr, slope)
                updated += 1
                log.info(
                    "Tee %s (%s %s): CR=%s Slope=%s opgeslagen.",
                    tee_id, r.get("course"), r.get("tee"), cr, slope,
                )
            else:
                log.debug("Geen CR/slope in scorekaart %s — niet op de pagina.", scorecard_id)
            seen_tees.add(tee_id)
        except Exception as e:  # noqa: BLE001
            failed += 1
            log.warning("Scorekaart %s mislukt: %s", scorecard_id, e)

        time.sleep(0.15)

    log.info(
        "Gebruiker %s klaar — %d tee(s) bijgewerkt, %d mislukt.",
        user_id, updated, failed,
    )
    return updated, failed


# ---------------------------------------------------------------------------
# Statusoverzicht
# ---------------------------------------------------------------------------

def print_status() -> None:
    total = sb_get(
        "rounds",
        "?select=id&golfnl_scorecard_id=not.is.null&course_tee_id=not.is.null&deleted_at=is.null",
    )
    with_cr = sb_get(
        "course_tees",
        "?select=id&course_rating=not.is.null&slope_rating=not.is.null",
    )
    without_cr = sb_get(
        "course_tees",
        "?select=id&or=(course_rating.is.null,slope_rating.is.null)",
    )
    print(f"\n=== CR/slope voortgang ===")
    print(f"Rondes met scorecard_id + tee: {len(total)}")
    print(f"Tees met beide CR+slope:        {len(with_cr)}")
    print(f"Tees zonder (een van) CR/slope: {len(without_cr)}")
    print()


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    mode = sys.argv[1].lower() if len(sys.argv) > 1 else "backfill"

    require_env("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")
    if not supabase_key:
        log.error("Geen Supabase-key: stel SUPABASE_SERVICE_KEY in.")
        sys.exit(2)

    if mode == "status":
        print_status()
        return

    users = sb_get_user_settings()
    if GOLF_USER_ID and users:
        users = [u for u in users if u["user_id"] == GOLF_USER_ID]

    golfnl_env_user = os.environ.get("GOLFNL_USERNAME", "")
    golfnl_env_pass = os.environ.get("GOLFNL_PASSWORD", "")
    if not users and golfnl_env_user and golfnl_env_pass and GOLF_USER_ID:
        users = [{"user_id": GOLF_USER_ID, "golfnl_username": golfnl_env_user,
                  "golfnl_password": golfnl_env_pass}]

    if not users:
        log.error("Geen gebruikers met GOLF.NL-credentials. Stel ze in via de app.")
        sys.exit(2)

    log.info("%d gebruiker(s) te verwerken.", len(users))
    total_updated = total_failed = 0
    for u in users:
        upd, fail = backfill_one_user(
            u["golfnl_username"], u["golfnl_password"], u["user_id"],
        )
        total_updated += upd
        total_failed += fail

    log.info("Klaar — %d tee(s) bijgewerkt, %d mislukt.", total_updated, total_failed)
    if total_failed > 0 and total_updated == 0:
        sys.exit(1)


if __name__ == "__main__":
    run_main(main)
