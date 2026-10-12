"""Create Mia's meeting calendar, owned by her service account, and share it.

Mobile Apps Labs' Google Workspace won't let staff give an outside account
(the service account) edit rights on their calendars, so the calendar belongs
to the service account and is shared INTO the company instead, which is
allowed. Run once, inside the worker image, with the key mounted:

    docker run --rm -v "<path>\\google-service-account.json":/app/google-service-account.json:ro \
        -v "<agent-worker>":/w -w /w simli-worker python create_calendar.py \
        eabdo@mobileappslabs.com=owner ajoset@mobileappslabs.com=writer nbastien@mobileappslabs.com=writer

It prints the calendar ID for GOOGLE_CALENDAR_ID. Run again to add people to
the existing calendar (found by name). Everyone listed gets Google's email.
Roles: owner (manage sharing too) or writer (make changes to events).
"""

import sys
from urllib.parse import quote

import requests
from google.auth.transport.requests import Request
from google.oauth2 import service_account

NAME = "Mobile Apps Labs – Meetings"
API = "https://www.googleapis.com/calendar/v3"


def main() -> None:
    creds = service_account.Credentials.from_service_account_file(
        "/app/google-service-account.json", scopes=["https://www.googleapis.com/auth/calendar"]
    )
    creds.refresh(Request())
    headers = {"Authorization": f"Bearer {creds.token}"}

    mine = requests.get(f"{API}/users/me/calendarList", headers=headers, timeout=20).json().get("items", [])
    found = next((c for c in mine if c.get("summary") == NAME), None)
    if found:
        cal_id = found["id"]
        print("calendar exists:", cal_id)
    else:
        r = requests.post(
            f"{API}/calendars",
            headers=headers,
            json={"summary": NAME, "timeZone": "America/Toronto", "description": "Meetings booked by Mia, the virtual receptionist."},
            timeout=20,
        )
        r.raise_for_status()
        cal_id = r.json()["id"]
        print("calendar created:", cal_id)

    for arg in sys.argv[1:]:
        email, _, role = arg.partition("=")
        r = requests.post(
            f"{API}/calendars/{quote(cal_id, safe='')}/acl",
            headers=headers,
            params={"sendNotifications": "true"},
            json={"role": role or "writer", "scope": {"type": "user", "value": email}},
            timeout=20,
        )
        print("shared with", email, role or "writer", "->", "ok" if r.ok else f"{r.status_code} {r.text[:200]}")

    print(f"\nGOOGLE_CALENDAR_ID={cal_id}")


if __name__ == "__main__":
    main()
