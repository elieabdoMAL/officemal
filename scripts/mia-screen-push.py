"""Dev only: talk to a kiosk screen the way the worker does (docs/screen-protocol.md).

Joins one kiosk room as an extra participant and, in order, for each argument:
  '{"type": "contact_card"}'              push a screen message on "mia.screen"
  '{"attributes": {"mia.state": "paused"}}'  set attributes on itself (the
                                          screen reads mia.* from any remote
                                          participant, worker or not)
  '{"sleep": 3}'                          wait
then prints any "mia.control" messages the screen sent, and leaves.

The room name is printed in the kiosk's browser console ("[SimliLK] in room
kiosk-..."). Always name the room: the LiveKit project is shared with the live
kiosk. Runs in the worker image, which has the LiveKit SDK; from the repo root
in Git Bash:

  MSYS_NO_PATHCONV=1 docker run --rm --env-file agent-worker/.env \
    -v "$(cygpath -w "$PWD/scripts")":/s --entrypoint python simli-worker:<x> \
    /s/mia-screen-push.py kiosk-... '{"type":"message_sent","to":"Nicolas Bastien"}'
"""

import asyncio
import json
import os
import sys

from livekit import api, rtc

IDENTITY = "dev-screen-push"


async def main(room_name: str, steps: list[dict]) -> None:
    token = (
        api.AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
        .with_identity(IDENTITY)
        # can_update_own_metadata: without it LiveKit silently drops set_attributes.
        .with_grants(api.VideoGrants(room_join=True, room=room_name, can_update_own_metadata=True))
        .to_jwt()
    )
    room = rtc.Room()

    def on_control(reader: rtc.TextStreamReader, identity: str) -> None:
        async def read() -> None:
            print(f"control from {identity}: {await reader.read_all()}")

        asyncio.ensure_future(read())

    room.register_text_stream_handler("mia.control", on_control)
    await room.connect(os.environ["LIVEKIT_URL"], token)
    print(f"joined {room_name} as {IDENTITY}; participants: {list(room.remote_participants)}")
    for step in steps:
        if "sleep" in step:
            await asyncio.sleep(float(step["sleep"]))
        elif "attributes" in step:
            await room.local_participant.set_attributes(step["attributes"])
            print(f"attributes {step['attributes']}")
        else:
            await room.local_participant.send_text(json.dumps(step), topic="mia.screen")
            print(f"sent {step}")
    await asyncio.sleep(1)
    await room.disconnect()


if __name__ == "__main__":
    if len(sys.argv) < 3 or not sys.argv[1].startswith("kiosk-"):
        sys.exit(__doc__)
    asyncio.run(main(sys.argv[1], [json.loads(a) for a in sys.argv[2:]]))
