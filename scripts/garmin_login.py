#!/usr/bin/env python3
"""
Eenmalig interactief inloggen op Garmin Connect.

Garmin stuurt bij een nieuwe login een verificatiecode per e-mail (OTP).
Dit script handelt die code interactief af en slaat het sessie-token
versleuteld op in Supabase. De dagelijkse sync hergebruikt dat token
zodat er geen OTP meer nodig is.

Gebruik (éénmalig per account, door elke gebruiker zelf):
    pip install -r scripts/requirements.txt
    python scripts/garmin_login.py

Het script vraagt om:
  - Je Golf Tracker app-login (e-mail + wachtwoord)
  - Je Garmin Connect-login (e-mail + wachtwoord)
  - De verificatiecode die Garmin per e-mail stuurt

Geen service keys of technische kennis vereist.
"""

import os
import sys
import getpass
import requests

# Publieke constanten — zelfde als in js/config.js
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ptrccpfqnvygrqmsykob.supabase.co")
SUPABASE_ANON_KEY = os.environ.get(
    "SUPABASE_ANON_KEY",
    "sb_publishable_mY2XiMffONLDlVLDOnkTqw_vEgP9Iwd",
)

GARMIN_EMAIL = os.environ.get("GARMIN_EMAIL", "")
GARMIN_PASSWORD = os.environ.get("GARMIN_PASSWORD", "")


def prompt(label: str, secret: bool = False) -> str:
    fn = getpass.getpass if secret else input
    val = fn(f"{label}: ").strip()
    if not val:
        print(f"Fout: {label} mag niet leeg zijn.")
        sys.exit(1)
    return val


def supabase_login(email: str, password: str) -> str:
    """Logt in op Supabase en geeft het JWT terug."""
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": password},
        timeout=15,
    )
    if not r.ok:
        msg = r.json().get("error_description") or r.json().get("msg") or r.text
        print(f"✗ Inloggen op Golf Tracker mislukt: {msg}")
        sys.exit(1)
    return r.json()["access_token"]


def garmin_login(email: str, password: str):
    """Logt in op Garmin Connect. Vraagt interactief om OTP als dat vereist is."""
    from garminconnect import Garmin  # importeer laat zodat foutmeldingen duidelijker zijn
    g = Garmin(email=email, password=password)
    g.login()
    return g


def save_token(jwt: str, garmin_token_str: str, garmin_email: str) -> None:
    """Slaat het Garmin-token + e-mailadres versleuteld op via de Edge Function."""
    r = requests.post(
        f"{SUPABASE_URL}/functions/v1/save-garmin-token",
        headers={"Authorization": f"Bearer {jwt}", "Content-Type": "application/json"},
        json={"token": garmin_token_str, "username": garmin_email},
        timeout=30,
    )
    if not r.ok:
        print(f"✗ Token opslaan mislukt ({r.status_code}): {r.text}")
        sys.exit(1)


def main() -> None:
    global GARMIN_EMAIL, GARMIN_PASSWORD

    print("=== Garmin Connect koppelen aan Golf Tracker ===\n")

    # Stap 1: inloggen op de Golf Tracker app
    print("Stap 1: Golf Tracker app-account")
    app_email = prompt("App e-mailadres")
    app_password = prompt("App wachtwoord", secret=True)
    print("Inloggen op Golf Tracker…")
    jwt = supabase_login(app_email, app_password)
    print("✓ Ingelogd bij Golf Tracker.\n")

    # Stap 2: inloggen op Garmin Connect
    print("Stap 2: Garmin Connect")
    if not GARMIN_EMAIL:
        GARMIN_EMAIL = prompt("Garmin e-mailadres")
    if not GARMIN_PASSWORD:
        GARMIN_PASSWORD = prompt("Garmin wachtwoord", secret=True)

    print(f"\nInloggen op Garmin Connect als {GARMIN_EMAIL}…")
    print("Als Garmin een verificatiecode per e-mail stuurt, vul die dan hieronder in.\n")

    g = garmin_login(GARMIN_EMAIL, GARMIN_PASSWORD)
    print("\n✓ Ingelogd bij Garmin Connect!")

    # Stap 3: token opslaan
    print("Sessietoken opslaan in Supabase…")
    token_str = g.client.dumps()
    save_token(jwt, token_str, GARMIN_EMAIL)

    print("\n✓ Klaar! Garmin is gekoppeld aan je account.")
    print("  De dagelijkse sync draait voortaan automatisch zonder verificatiecode.")
    print("  Als het token ooit verloopt, draai dit script opnieuw.")


if __name__ == "__main__":
    main()
