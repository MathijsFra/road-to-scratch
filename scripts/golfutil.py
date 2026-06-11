"""Gedeelde helpers voor de sync-scripts: logging, env-validatie en
HTTP/calls met retry + exponentiële backoff. Bedoeld voor onbewaakt draaien."""

import logging
import os
import sys
import time

import requests

# Statuscodes die we als tijdelijk beschouwen en opnieuw proberen.
RETRYABLE_STATUS = {429, 500, 502, 503, 504}
RETRYABLE_EXC = (requests.ConnectionError, requests.Timeout)


def setup_logging(name: str) -> logging.Logger:
    level = os.environ.get("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    return logging.getLogger(name)


log = logging.getLogger("golf")


def require_env(*names: str) -> None:
    """Stopt met een duidelijke fout (exit 2) als een env-var ontbreekt."""
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        log.error("Ontbrekende environment variables: %s", ", ".join(missing))
        sys.exit(2)


def request_with_retry(method: str, url: str, *, session: requests.Session | None = None,
                       attempts: int = 4, base_delay: float = 2.0, timeout: int = 30,
                       **kwargs) -> requests.Response:
    """requests met retry op time-outs, connectiefouten en 429/5xx.
    4xx (behalve 429) worden NIET herhaald — dat is een echte fout.
    Geef een `session` mee om cookies/headers te behouden (bv. login)."""
    requester = session or requests
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            resp = requester.request(method, url, timeout=timeout, **kwargs)
            if resp.status_code in RETRYABLE_STATUS:
                raise requests.HTTPError(f"{resp.status_code} {resp.reason}", response=resp)
            resp.raise_for_status()
            return resp
        except requests.HTTPError as e:
            status = getattr(e.response, "status_code", None)
            if status is not None and status not in RETRYABLE_STATUS:
                raise  # echte client-fout (bv. 401/404) — niet herhalen
            last_exc = e
        except RETRYABLE_EXC as e:
            last_exc = e
        if attempt < attempts:
            delay = base_delay * (2 ** (attempt - 1))
            log.warning("HTTP-poging %d/%d mislukt (%s); opnieuw over %.0fs",
                        attempt, attempts, last_exc, delay)
            time.sleep(delay)
    raise last_exc  # type: ignore[misc]


def retry_call(fn, *args, attempts: int = 3, base_delay: float = 2.0, **kwargs):
    """Herhaalt een willekeurige callable (bv. een Garmin API-call) bij fouten."""
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fn(*args, **kwargs)
        except Exception as e:  # noqa: BLE001 - bewust breed voor onbewaakt draaien
            last_exc = e
            if attempt < attempts:
                delay = base_delay * (2 ** (attempt - 1))
                log.warning("Poging %d/%d mislukt (%s); opnieuw over %.0fs",
                            attempt, attempts, e, delay)
                time.sleep(delay)
    raise last_exc  # type: ignore[misc]


def run_main(main_fn) -> None:
    """Draait main() met nette top-level foutafhandeling en exit-codes:
    0 = ok, 1 = fout, 2 = config-fout (via require_env/SystemExit)."""
    try:
        main_fn()
    except SystemExit:
        raise  # respecteer expliciete sys.exit(...)
    except KeyboardInterrupt:
        log.warning("Onderbroken door gebruiker.")
        sys.exit(130)
    except Exception:
        log.exception("Onverwachte fout — sync afgebroken.")
        sys.exit(1)
