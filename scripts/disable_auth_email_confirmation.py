"""Disable Supabase Auth email confirmation using the Management API."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    with (ROOT / "config.secret.json").open("r", encoding="utf-8-sig") as source:
        secret = json.load(source)
    access_token = str(secret.get("SUPABASE_ACCESS_TOKEN", "")).strip()
    project_ref = str(secret.get("SUPABASE_PROJECT_REF", "")).strip()
    if not access_token or not project_ref:
        raise RuntimeError("Supabase Management API credentials are missing from config.secret.json.")

    url = (
        "https://api.supabase.com/v1/projects/"
        f"{urllib.parse.quote(project_ref, safe='')}/config/auth"
    )
    request = urllib.request.Request(
        url,
        data=json.dumps({"mailer_autoconfirm": True}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        method="PATCH",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            response.read()
    except urllib.error.HTTPError as error:
        # Avoid printing the response body; auth config responses may contain
        # project settings that should stay private.
        raise RuntimeError(
            f"Supabase Auth configuration update failed (HTTP {error.code})."
        ) from error
    print("Supabase Auth email confirmation is disabled.")


if __name__ == "__main__":
    main()
