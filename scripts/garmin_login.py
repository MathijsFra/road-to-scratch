#!/usr/bin/env python3
"""
Eenmalige Garmin Connect-login -> token.

Garmin gebruikt SSO + vaak MFA, wat onbewaakt inloggen lastig maakt. Daarom
log je hier één keer interactief in (MFA-code uit je mail/app), en krijg je een
token-string die je daarna als GitHub-secret `GARMIN_TOKEN` zet. De geplande
sync gebruikt dat token (wordt automatisch ververst tot het verloopt, ~1 jaar).

Gebruik:
    pip install -r scripts/requirements.txt
    python scripts/garmin_login.py
"""

import os
import sys
import getpass
from garminconnect import Garmin


def main() -> None:
    email = os.environ.get("GARMIN_EMAIL") or input("Garmin e-mail: ").strip()
    password = os.environ.get("GARMIN_PASSWORD") or getpass.getpass("Garmin wachtwoord: ")
    if not email or not password:
        sys.exit("E-mail en wachtwoord zijn verplicht.")

    try:
        garmin = Garmin(
            email=email,
            password=password,
            prompt_mfa=lambda: input("MFA-code (uit je mail/Garmin-app): ").strip(),
        )
        garmin.login()
    except Exception as e:
        sys.exit(f"\n❌ Inloggen mislukt: {e}\n"
                 "Controleer e-mail/wachtwoord en de MFA-code. Probeer het opnieuw.")

    # Token lokaal opslaan (handig om lokaal te draaien) ...
    tokenstore = os.path.expanduser("~/.garminconnect")
    garmin.client.dump(tokenstore)

    # ... en als string printen voor de GitHub-secret.
    token = garmin.client.dumps()
    print("\n✅ Login gelukt. Token opgeslagen in:", tokenstore)
    print("\n=== Zet dit als GitHub-secret  GARMIN_TOKEN  ===\n")
    print(token)
    print("\n(Bewaar 'm goed — het geeft toegang tot je Garmin-account.)")


if __name__ == "__main__":
    main()
