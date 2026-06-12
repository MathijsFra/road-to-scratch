#!/usr/bin/env python3
"""
Seed golfbaan-database vanuit GolfCourseAPI.com.

Modi:
  discover  - zoek alle NL course-IDs en zet ze in de wachtrij
  fetch     - haal per-dag details op voor wachtende courses (max 50 per key)
  status    - toon voortgang van de seed

Gebruik:
  python scripts/seed_courses.py discover
  python scripts/seed_courses.py fetch
  python scripts/seed_courses.py status

Omgevingsvariabelen:
  SUPABASE_URL, SUPABASE_SERVICE_KEY   — Supabase-verbinding
  GOLFCOURSEAPI_KEY_1 .. KEY_N         — API-keys (minimaal 1)
  GOLF_COUNTRY                         — ISO-landcode (standaard: NL)
  LOG_LEVEL                            — DEBUG voor uitgebreide output

Automatisch via .github/workflows/seed-courses.yml.
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

from golfutil import run_main, setup_logging

log = setup_logging("seed_courses")

BASE_URL      = "https://api.golfcourseapi.com/v1"
COUNTRY       = os.environ.get("GOLF_COUNTRY", "NL")
LIMIT_PER_KEY = 50   # dagelijks verzoek-budget per API-key
SUPABASE_URL  = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY  = os.environ.get("SUPABASE_SERVICE_KEY", "")

# Brede zoektermen om alle Nederlandse banen te ontdekken.
# Combinatie van naam-patronen + provincies + steden geeft maximale dekking.
NL_SEARCH_TERMS = [
    "golf",
    "golfclub",
    "golfbaan",
    "country club",
    "golf & country",
    # Provincies
    "noord-holland", "zuid-holland", "utrecht", "gelderland",
    "noord-brabant", "overijssel", "friesland", "groningen",
    "drenthe", "flevoland", "zeeland", "limburg",
    # Grote steden
    "amsterdam", "rotterdam", "den haag", "eindhoven", "tilburg",
    "almere", "breda", "nijmegen", "enschede", "apeldoorn",
    "arnhem", "zwolle", "amersfoort", "leiden", "haarlem",
    "maastricht", "den bosch", "venlo", "deventer", "sittard",
    "leeuwarden", "alkmaar", "delft", "hilversum", "gouda",
    "hoorn", "assen", "emmen", "lelystad", "middelburg",
    "roosendaal", "vlaardingen", "dordrecht", "zoetermeer",
]


# ---------------------------------------------------------------------------
# Hulpfuncties
# ---------------------------------------------------------------------------

def sb_headers() -> dict:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Key-rotatie
# ---------------------------------------------------------------------------

class RateLimitError(Exception):
    pass


class KeyRotator:
    """
    Roteert door meerdere API-keys en houdt het verbruik per key bij.
    Elke key heeft een dagelijks budget van LIMIT_PER_KEY verzoeken.
    """

    def __init__(self, keys: list[str], limit: int = LIMIT_PER_KEY):
        self.keys    = keys
        self.limit   = limit
        self.usage   = [0] * len(keys)
        self._idx    = 0

    @property
    def current_key(self) -> str | None:
        """Geeft de actieve key terug, of None als alles uitgeput is."""
        for offset in range(len(self.keys)):
            idx = (self._idx + offset) % len(self.keys)
            if self.usage[idx] < self.limit:
                self._idx = idx
                return self.keys[idx]
        return None

    def consume(self) -> None:
        """Registreer één verbruikt verzoek."""
        self.usage[self._idx] += 1
        log.debug(
            "Key ...%s: %d/%d verzoeken gebruikt.",
            self.keys[self._idx][-4:], self.usage[self._idx], self.limit,
        )

    @property
    def total_budget(self) -> int:
        return self.limit * len(self.keys)

    @property
    def remaining(self) -> int:
        return sum(max(0, self.limit - u) for u in self.usage)

    @property
    def exhausted(self) -> bool:
        return self.current_key is None


def get_api_keys() -> list[str]:
    """Laadt alle GOLFCOURSEAPI_KEY_N env vars (KEY_1, KEY_2, ...)."""
    keys = []
    for i in range(1, 20):
        k = os.environ.get(f"GOLFCOURSEAPI_KEY_{i}")
        if k:
            keys.append(k.strip())
    if not keys:
        log.error(
            "Geen API-key gevonden. Stel GOLFCOURSEAPI_KEY_1 (en eventueel _2, _3, …) in."
        )
        sys.exit(2)
    log.info("%d API-key(s) geladen. Dagelijks budget: %d verzoeken.", len(keys), len(keys) * LIMIT_PER_KEY)
    return keys


# ---------------------------------------------------------------------------
# GolfCourseAPI aanroepen
# ---------------------------------------------------------------------------

def api_get(path: str, key: str, params: dict | None = None) -> dict:
    """
    GET-verzoek naar GolfCourseAPI.
    Gooit RateLimitError bij 429, gewone HTTPError bij andere fouten.
    """
    resp = requests.get(
        f"{BASE_URL}{path}",
        headers={"Authorization": f"Key {key}"},
        params=params,
        timeout=20,
    )
    if resp.status_code == 429:
        log.warning("Rate limit (429) op key ...%s.", key[-4:])
        raise RateLimitError(key)
    resp.raise_for_status()
    return resp.json()


def api_get_with_rotation(path: str, rotator: KeyRotator, params: dict | None = None) -> dict | None:
    """
    Doet een API-verzoek met automatische key-rotatie bij rate limits.
    Geeft None terug als het budget volledig uitgeput is.
    """
    for _ in range(len(rotator.keys)):
        key = rotator.current_key
        if key is None:
            return None
        try:
            data = api_get(path, key, params)
            rotator.consume()
            return data
        except RateLimitError:
            # Forceer overstap naar volgende key
            rotator.usage[rotator._idx] = rotator.limit
        except requests.HTTPError as e:
            log.warning("HTTP-fout op %s: %s", path, e)
            rotator.consume()  # verzoek is toch verbruikt
            raise
    return None


# ---------------------------------------------------------------------------
# Supabase helpers
# ---------------------------------------------------------------------------

def sb_get(path: str, params: dict | None = None) -> list[dict]:
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers=sb_headers(),
        params=params,
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()


def sb_post(path: str, body, prefer: str = "return=minimal") -> requests.Response:
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={**sb_headers(), "Prefer": prefer},
        data=json.dumps(body),
        timeout=20,
    )
    resp.raise_for_status()
    return resp


def sb_patch(path: str, body: dict) -> None:
    resp = requests.patch(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={**sb_headers(), "Prefer": "return=minimal"},
        data=json.dumps(body),
        timeout=20,
    )
    resp.raise_for_status()


# ---------------------------------------------------------------------------
# DISCOVER: vind alle course-IDs voor het land
# ---------------------------------------------------------------------------

def get_known_ids() -> set[int]:
    """Haalt alle al bekende GolfCourseAPI-IDs op (queue + courses tabel)."""
    ids: set[int] = set()
    for row in sb_get("course_seed_queue?select=golfcourseapi_id"):
        ids.add(row["golfcourseapi_id"])
    for row in sb_get("courses?select=golfcourseapi_id&golfcourseapi_id=not.is.null"):
        if row.get("golfcourseapi_id"):
            ids.add(row["golfcourseapi_id"])
    return ids


def discover_course_ids(rotator: KeyRotator) -> int:
    """
    Doorzoekt de API met meerdere zoektermen en vult de seed-queue.
    Geeft het aantal nieuw gevonden IDs terug.
    """
    known   = get_known_ids()
    new_ids: set[int] = set()

    for term in NL_SEARCH_TERMS:
        if rotator.exhausted:
            log.warning("Budget uitgeput na zoekterm '%s'. Morgen verder.", term)
            break

        page = 1
        while True:
            if rotator.exhausted:
                break
            try:
                data = api_get_with_rotation(
                    "/search", rotator,
                    params={"search_query": term, "country": COUNTRY, "page": page},
                )
            except Exception as e:
                log.warning("Zoekterm '%s' pagina %d mislukt: %s", term, page, e)
                break

            if data is None:
                break  # budget op

            courses = data.get("courses", [])
            if not courses:
                break

            found_new = 0
            for c in courses:
                cid = c.get("id")
                if cid and cid not in known and cid not in new_ids:
                    new_ids.add(cid)
                    found_new += 1

            log.debug(
                "Zoekterm '%s' p%d: %d resultaten, %d nieuw.",
                term, page, len(courses), found_new,
            )

            # Paginering: sommige responses geven total_count mee
            total = data.get("total_count", 0) or data.get("count", 0)
            per_page = len(courses)
            if not total or (page * per_page) >= total or per_page == 0:
                break
            page += 1
            time.sleep(0.15)

    if new_ids:
        rows = [{"golfcourseapi_id": cid} for cid in sorted(new_ids)]
        sb_post(
            "course_seed_queue",
            rows,
            prefer="resolution=ignore-duplicates,return=minimal",
        )
        log.info("%d nieuwe course-IDs toegevoegd aan de wachtrij.", len(new_ids))
    else:
        log.info("Geen nieuwe course-IDs gevonden.")

    return len(new_ids)


# ---------------------------------------------------------------------------
# FETCH: haal details op voor wachtende courses
# ---------------------------------------------------------------------------

def get_pending_ids(limit: int) -> list[int]:
    """Haalt wachtende IDs op (fetched_at IS NULL), gesorteerd op ontdekking."""
    rows = sb_get(
        f"course_seed_queue"
        f"?fetched_at=is.null"
        f"&error_message=is.null"   # skip eerder mislukte (die worden dagelijks 1x herproefd)
        f"&select=golfcourseapi_id"
        f"&order=discovered_at.asc"
        f"&limit={limit}",
    )
    ids = [r["golfcourseapi_id"] for r in rows]

    # Vul aan met eerder mislukte als er budget over is
    if len(ids) < limit:
        retry_rows = sb_get(
            f"course_seed_queue"
            f"?fetched_at=is.null"
            f"&error_message=not.is.null"
            f"&select=golfcourseapi_id"
            f"&order=discovered_at.asc"
            f"&limit={limit - len(ids)}",
        )
        ids += [r["golfcourseapi_id"] for r in retry_rows]

    return ids


def mark_done(cid: int) -> None:
    sb_patch(
        f"course_seed_queue?golfcourseapi_id=eq.{cid}",
        {"fetched_at": now_iso(), "error_message": None},
    )


def mark_error(cid: int, error: str) -> None:
    sb_patch(
        f"course_seed_queue?golfcourseapi_id=eq.{cid}",
        {"error_message": error[:500]},
    )


def parse_tee_gender(gender_key: str) -> str:
    """Normaliseert de gender-sleutel uit de API naar 'male'/'female'/'unspecified'."""
    g = gender_key.lower()
    if g in ("male", "men", "man", "heren"):
        return "male"
    if g in ("female", "women", "woman", "dames"):
        return "female"
    return "unspecified"


def upsert_course(api_course: dict) -> None:
    """Sla één course + alle tees op in Supabase (upsert op golfcourseapi_id)."""
    loc = api_course.get("location") or {}

    course_row = {
        "golfcourseapi_id": api_course["id"],
        "name":    (api_course.get("club_name") or api_course.get("course_name") or "").strip() or "Onbekend",
        "city":    loc.get("city"),
        "state":   loc.get("state"),
        "country": loc.get("country", COUNTRY),
        "latitude":  loc.get("latitude"),
        "longitude": loc.get("longitude"),
        "updated_at": now_iso(),
    }

    resp = sb_post(
        "courses",
        course_row,
        prefer="resolution=merge-duplicates,return=representation",
    )
    rows = resp.json()
    if not rows or not isinstance(rows, list):
        raise ValueError(f"Onverwachte upsert-response: {resp.text[:200]}")
    course_id = rows[0]["id"]

    # Tees upserten
    tees_data = api_course.get("tees") or {}
    tee_rows = []
    for gender_key, tees in tees_data.items():
        if not isinstance(tees, list):
            continue
        gender = parse_tee_gender(gender_key)
        for tee in tees:
            name = (tee.get("tee_name") or "").strip()
            if not name:
                continue
            tee_rows.append({
                "course_id":     course_id,
                "tee_name":      name,
                "tee_gender":    gender,
                "holes":         int(tee.get("holes", 18) or 18),
                "par":           tee.get("par"),
                "course_rating": tee.get("course_rating"),
                "slope_rating":  tee.get("slope_rating"),
                "bogey_rating":  tee.get("bogey_rating"),
            })

    if tee_rows:
        sb_post(
            "course_tees",
            tee_rows,
            prefer="resolution=merge-duplicates,return=minimal",
        )


def fetch_pending_courses(rotator: KeyRotator) -> tuple[int, int]:
    """
    Haal details op voor courses in de wachtrij tot het budget op is.
    Geeft (geslaagd, mislukt) terug.
    """
    pending = get_pending_ids(limit=rotator.total_budget)

    if not pending:
        log.info("Geen openstaande courses in de wachtrij. Database is compleet!")
        return 0, 0

    log.info(
        "%d courses te verwerken (budget: %d verzoeken over %d key(s)).",
        len(pending), rotator.total_budget, len(rotator.keys),
    )
    success = failed = 0

    for cid in pending:
        if rotator.exhausted:
            log.info("Budget uitgeput. Nog %d courses wachten — morgen verder.", len(pending) - success - failed)
            break

        try:
            data = api_get_with_rotation(f"/courses/{cid}", rotator)
            if data is None:
                break  # budget op

            course = data.get("course") or data  # sommige responses pakken alles in "course"
            if not course or not course.get("id"):
                raise ValueError(f"Lege of ongeldige response: {str(data)[:200]}")

            upsert_course(course)
            mark_done(cid)
            success += 1
            log.debug(
                "Course %d opgeslagen: %s (%s).",
                cid,
                course.get("club_name") or course.get("course_name", "?"),
                (course.get("location") or {}).get("city", "?"),
            )

        except RateLimitError:
            # Wordt al afgehandeld in api_get_with_rotation; hier zouden we nooit komen
            pass
        except Exception as e:
            failed += 1
            mark_error(cid, str(e))
            log.warning("Course %d mislukt: %s", cid, e)

        time.sleep(0.1)  # beleefd voor de API

    log.info(
        "Klaar — geslaagd: %d, mislukt: %d, resterend budget: %d.",
        success, failed, rotator.remaining,
    )
    return success, failed


# ---------------------------------------------------------------------------
# STATUS: voortgang tonen
# ---------------------------------------------------------------------------

def print_status() -> None:
    total_rows  = sb_get("course_seed_queue?select=golfcourseapi_id")
    done_rows   = sb_get("course_seed_queue?fetched_at=not.is.null&select=golfcourseapi_id")
    error_rows  = sb_get("course_seed_queue?error_message=not.is.null&fetched_at=is.null&select=golfcourseapi_id")
    course_rows = sb_get("courses?select=id&country=eq.NL")
    tee_rows    = sb_get("course_tees?select=id")

    total   = len(total_rows)
    done    = len(done_rows)
    errors  = len(error_rows)
    pending = total - done
    pct     = (done / total * 100) if total else 0

    print(f"\n=== Seed voortgang ===")
    print(f"Wachtrij:   {total} totaal | {done} klaar | {pending} wacht | {errors} fout")
    print(f"Database:   {len(course_rows)} banen | {len(tee_rows)} tees")
    print(f"Voortgang:  {pct:.0f}%  {'✓ Compleet!' if pending == 0 and total > 0 else ''}")
    print()


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------

def main() -> None:
    mode = sys.argv[1].lower() if len(sys.argv) > 1 else "fetch"

    if not SUPABASE_URL or not SUPABASE_KEY:
        log.error("SUPABASE_URL en SUPABASE_SERVICE_KEY zijn verplicht.")
        sys.exit(2)

    if mode == "status":
        print_status()
        return

    keys     = get_api_keys()
    rotator  = KeyRotator(keys)

    if mode == "discover":
        log.info("Modus: discover | land: %s | budget: %d verzoeken.", COUNTRY, rotator.total_budget)
        discover_course_ids(rotator)

    elif mode == "fetch":
        log.info("Modus: fetch | land: %s | budget: %d verzoeken.", COUNTRY, rotator.total_budget)
        fetch_pending_courses(rotator)
        print_status()

    else:
        log.error("Onbekende modus '%s'. Gebruik: discover, fetch of status.", mode)
        sys.exit(2)


if __name__ == "__main__":
    run_main(main)
