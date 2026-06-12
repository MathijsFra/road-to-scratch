#!/usr/bin/env python3
"""
Sync Toptracer -> Supabase.

Haalt per gebruiker club-afstanden op via de Toptracer GraphQL-API
en schrijft ze naar de tabel `toptracer_clubs`.

Auth: OAuth2 PKCE-flow via de app (eenmalig); daarna refresh-token.
Vereiste environment variables:
  SUPABASE_URL, SUPABASE_SERVICE_KEY
"""

import os
import sys
import json
import datetime as dt

from golfutil import setup_logging, require_env, request_with_retry, run_main

log = setup_logging("toptracer")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")
GOLF_USER_ID = os.environ.get("GOLF_USER_ID", "")

TOPTRACER_TOKEN_URL = (
    "https://login.toptracer.com/realms/toptracer/protocol/openid-connect/token"
)
TOPTRACER_GRAPHQL_URL = "https://api.toptracer.com/api/appsbff/graphql"
TOPTRACER_CLIENT_ID = "trca"

CLUBS_QUERY = """
query GetUserClubs {
  userClubs {
    clubs {
      id
      clubType
      clubTypeDisplayName
      category
      isHidden
      averages {
        carry
        total
      }
    }
  }
}
"""


# ============================================================
#  Supabase helpers
# ============================================================
def sb_headers() -> dict:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def sb_get_credentials() -> list[dict]:
    """Haalt alle accounts met ontsleutelde Toptracer refresh-tokens op."""
    resp = request_with_retry(
        "GET",
        f"{SUPABASE_URL}/functions/v1/get-toptracer-creds",
        headers={"Authorization": f"Bearer {SUPABASE_KEY}"},
        timeout=30,
    )
    return resp.json()


def sb_save_token(user_id: str, token: str) -> None:
    """Slaat een vernieuwd refresh-token versleuteld op."""
    request_with_retry(
        "POST",
        f"{SUPABASE_URL}/functions/v1/save-toptracer-token",
        headers={"Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
        data=json.dumps({"user_id": user_id, "token": token}),
        timeout=30,
    )


def sb_upsert_clubs(user_id: str, clubs: list[dict]) -> int:
    """Schrijft club-afstanden weg naar toptracer_clubs (upsert op user_id + club_type)."""
    if not clubs:
        return 0
    rows = []
    for c in clubs:
        if c.get("isHidden"):
            continue
        avg = c.get("averages") or {}
        rows.append({
            "user_id": user_id,
            "club_type": c["clubType"],
            "club_display_name": c.get("clubTypeDisplayName"),
            "avg_carry_m": avg.get("carry"),
            "avg_total_m": avg.get("total"),
            "updated_at": dt.datetime.utcnow().isoformat() + "Z",
        })

    if not rows:
        return 0

    request_with_retry(
        "POST",
        f"{SUPABASE_URL}/rest/v1/toptracer_clubs",
        headers={
            **sb_headers(),
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        data=json.dumps(rows),
        timeout=30,
    )
    return len(rows)


# ============================================================
#  Toptracer API
# ============================================================
def refresh_access_token(refresh_token: str) -> tuple[str, str]:
    """Wisselt refresh-token in voor een nieuw access-token + refresh-token."""
    resp = request_with_retry(
        "POST",
        TOPTRACER_TOKEN_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data=f"grant_type=refresh_token&client_id={TOPTRACER_CLIENT_ID}&refresh_token={refresh_token}",
        timeout=30,
    )
    data = resp.json()
    access_token = data.get("access_token")
    new_refresh = data.get("refresh_token", refresh_token)
    if not access_token:
        raise RuntimeError(f"Geen access_token in respons: {data}")
    return access_token, new_refresh


def graphql(query: str, access_token: str) -> dict:
    resp = request_with_retry(
        "POST",
        TOPTRACER_GRAPHQL_URL,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        data=json.dumps({"query": query}),
        timeout=30,
    )
    return resp.json()


# ============================================================
#  Sync per gebruiker
# ============================================================
def sync_one_user(user_id: str, username: str, refresh_token: str) -> int:
    log.info("Verwerken %s (%s)…", user_id, username)

    # Nieuw access-token ophalen
    access_token, new_refresh = refresh_access_token(refresh_token)

    # Vernieuwd refresh-token opslaan
    if new_refresh != refresh_token:
        try:
            sb_save_token(user_id, new_refresh)
            log.debug("  Refresh-token vernieuwd.")
        except Exception as e:  # noqa: BLE001
            log.warning("  Token opslaan mislukt (niet kritiek): %s", e)

    # Club-afstanden ophalen
    result = graphql(CLUBS_QUERY, access_token)
    if "errors" in result:
        raise RuntimeError(f"GraphQL-fout: {result['errors']}")

    clubs = (result.get("data") or {}).get("userClubs", {}).get("clubs") or []
    log.info("  %d club(s) ontvangen van Toptracer.", len(clubs))

    saved = sb_upsert_clubs(user_id, clubs)
    log.info("  %d club(s) opgeslagen.", saved)
    return saved


# ============================================================
#  main
# ============================================================
def main() -> None:
    require_env("SUPABASE_URL")
    if not SUPABASE_KEY:
        log.error("Geen Supabase-key: zet SUPABASE_SERVICE_KEY.")
        sys.exit(2)

    users = sb_get_credentials()

    if GOLF_USER_ID and users:
        users = [u for u in users if u["user_id"] == GOLF_USER_ID]

    if not users:
        log.info("Geen gebruikers met Toptracer-token. Koppel Toptracer via de app.")
        return

    log.info("%d gebruiker(s) te synchroniseren.", len(users))
    total, failed = 0, 0
    for u in users:
        try:
            total += sync_one_user(u["user_id"], u.get("toptracer_username", ""), u["toptracer_token"])
        except Exception as e:  # noqa: BLE001
            failed += 1
            log.error("Sync mislukt voor %s: %s", u["user_id"], e)

    log.info("Klaar. %d club(s) bijgewerkt, %d gebruiker(s) mislukt.", total, failed)
    if failed and total == 0:
        sys.exit(1)


if __name__ == "__main__":
    run_main(main)
