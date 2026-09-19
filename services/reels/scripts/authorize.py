#!/usr/bin/env python
"""One-time Google consent, run on your own machine.

    python scripts/authorize.py

Opens a browser, asks you to approve Drive access, and prints a refresh token to
paste into services/reels/.env as GOOGLE_REFRESH_TOKEN. The server never does
this dance itself — it only ever exchanges the refresh token for access tokens.

Two things that will waste an afternoon if missed:

  * The OAuth consent screen must NOT be left in "Testing". Google expires every
    refresh token issued by a testing-status app after exactly 7 days, and the
    failure shows up as `invalid_grant` with no other explanation. Set the app to
    Internal (if this is a Workspace domain) or publish it to Production first.
  * If the OAuth client is of type "Web application" rather than "Desktop app",
    add http://localhost:8765/ to its Authorized redirect URIs, or Google will
    refuse with redirect_uri_mismatch.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from google_auth_oauthlib.flow import InstalledAppFlow  # noqa: E402

from app.drive import SCOPES  # noqa: E402

PORT = int(os.environ.get("AUTHORIZE_PORT", "8765"))


def main() -> int:
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
    if not (client_id and client_secret):
        print("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first, e.g.\n"
              "  $env:GOOGLE_CLIENT_ID='…'; $env:GOOGLE_CLIENT_SECRET='…'\n"
              "or run this with the values already in services/reels/.env loaded.")
        return 1

    flow = InstalledAppFlow.from_client_config(
        {
            "installed": {
                "client_id": client_id,
                "client_secret": client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": [f"http://localhost:{PORT}/"],
            }
        },
        scopes=SCOPES,
    )
    # access_type=offline is what produces a refresh token at all; prompt=consent
    # forces a fresh one even if this account has approved the app before, which
    # is the difference between this working and printing None on a second run.
    creds = flow.run_local_server(port=PORT, access_type="offline", prompt="consent")

    if not creds.refresh_token:
        print("Google returned no refresh token. Revoke this app's access at "
              "https://myaccount.google.com/permissions and run again.")
        return 1

    print("\nAdd this to services/reels/.env:\n")
    print(f"GOOGLE_REFRESH_TOKEN={creds.refresh_token}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
