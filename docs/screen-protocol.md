# Mia ↔ kiosk screen protocol

How the worker (`agent-worker/worker.py`) and the kiosk panel
(`src/components/SimliLiveKitPanel.tsx`) talk about what is on screen. Screen
side: `src/lib/screenProtocol.ts`. Change both sides together.

Everything goes through the LiveKit room the kiosk joins for each session.
Participants in that room: the visitor (the kiosk browser), the worker
(`agent-…`, an agent participant), and the Simli avatar (`simli-avatar-agent`,
which only publishes her face and voice).

## 1. Her state and language: participant attributes (worker → screen)

The worker sets these on its own participant:

```python
await ctx.room.local_participant.set_attributes({"mia.state": "paused", "mia.language": "fr"})
```

| Attribute | Values | Screen |
|---|---|---|
| `mia.state` | `listening` (default) | Normal conversation: turn pill ("Go ahead — I'm listening", "Speaking"…). After 12 s with nobody speaking, the pill becomes the hint "Say “{name}” or tap to talk". |
| | `paused` (#24, #25) | Big banner "My name is {name} — say my name to talk to me" in place of the pill. The visitor's captions are hidden (they're talking to someone else). Tapping the banner sends `resume` (section 4). |
| `mia.language` | `fr` / `en` | Language of the banners, card labels and caption labels. Until it's set, the screen shows both (French first). |

Missing attribute = `listening`; any unknown state is shown as `listening`.
Set `listening` again when she resumes. Attributes are merged, so setting one
leaves the other alone.

## 2. Captions: `lk.transcription` (no worker change)

AgentSession already publishes both sides of the conversation as text streams
on the `lk.transcription` topic (livekit-agents 1.6.8, `voice/room_io/_output.py`):

- **Her words**: one stream per reply, sent by the worker, written a few words
  at a time in step with her audio. The screen grows the caption as they
  arrive and fades it 3.5–9 s (by length) after the stream closes.
- **The visitor's words**: sent with the visitor's identity, one stream per
  update (interim then final, `lk.transcription_final`), each the whole phrase
  so far. Shown smaller, above hers, and fades after ~3 s.

Captions show the text the LLM wrote, not what the TTS was fed. So anything
that rewrites text for the voice only (e.g. #6, digits spelled out for the TTS)
belongs in the agent's `tts_node`, where captions keep the digits; rewriting
the LLM's text itself puts the spelled-out version on screen too.

Keep the session's transcription output on (it is by default).

## 3. Screen cards: `mia.screen` (worker → screen)

One text stream per message, body is JSON with a `type`:

```python
await ctx.room.local_participant.send_text(
    json.dumps({"type": "message_sent", "kind": "message", "to": "Nicolas Bastien"}),
    topic="mia.screen",
)
```

| `type` | Fields | Screen | Send when (wave 2) |
|---|---|---|---|
| `contact_card` | `lang?` | Card on the right of the frame: phone, email, address, website, QR code to the website. Closes after 45 s or on ×. Same card as the panel's Contact button. | The visitor asks for contact details / the phone number (#6, #18). |
| `message_sent` | `kind?`, `to?`, `lang?` | Green ✓ card, closes after 10 s. Text by `kind`: `message` "Message sent to {to}", `notify` "{to} has been told you're here", `alert` "The team has been alerted", `suggestion` "Suggestion sent — thank you!", `project_request` "Project request sent". Without `to`: "Message sent" / "The team has been told you're here". | After the tool succeeded (`take_message` → SENT, `notify_member` → NOTIFIED, `alert_emergency` → ALERTED, the suggestion and project-request tools), in the same turn she says so (#3). |
| `dismiss` | – | Closes the current card. | The conversation moved on. |

`lang` (`fr`/`en`) overrides `mia.language` for that card. `to` is shown as
given (keep it to a display name: "Nicolas Bastien", not an email address).
One card at a time: a new one replaces the current one. Unknown types and bad
JSON are ignored (logged in the browser console), so the worker can start
sending a new type before the screen draws it.

Planned, not drawn yet (wave 2, #20):

```json
{"type": "project_request", "status": "draft" | "sent",
 "fields": {"name": "", "company": "", "email": "", "phone": "", "description": "", "budget": "", "timeline": ""}}
```

`draft`: show the form she filled in, for the visitor to check before she
sends it; `sent`: show it as sent. Field list to be confirmed with the boss.

## 4. Taps: `mia.control` (screen → worker)

The screen sends one text stream per tap, JSON with a `type`, to the room:

| `type` | When | Worker should |
|---|---|---|
| `resume` | Visitor tapped the "say my name" banner while `paused`. | Do what hearing her name does: set `mia.state` back to `listening` and answer. |
| `wake` | Visitor tapped the "Say {name} or tap to talk" hint (in session, listening, nobody spoke for 12 s). | Optional: a short "Yes? How can I help?". The mic is already open, so ignoring it is fine. |

```python
def on_control(reader, participant_identity):
    async def read():
        msg = json.loads(await reader.read_all())
        ...
    asyncio.create_task(read())

ctx.room.register_text_stream_handler("mia.control", on_control)
```

Without a handler the worker just ignores these: until it handles `resume`,
the banner stays up after a tap and the visitor has to say her name.

## 5. Kiosk page ↔ embed (window messages)

Between the top page's AI button (`src/components/AiToggle.tsx`) and the
embed inside the tour's AIWEB Web Frame. Same origin.

| Message | Direction | Meaning |
|---|---|---|
| `{type: "receptionist-visible", visible}` / `{type: "receptionist-mute", muted}` | page → embed | AIWEB shown/hidden. The current tour unloads the frame when hidden, so this matters only for builds that keep it loaded. Shown again also wakes her from resting. |
| `{type: "receptionist-start"}` | page → embed | AI button tapped while she rests: start a session. |
| `{type: "receptionist-ended"}` | embed → page | Her session ended on its own (idle / max length / network). She rests: frame stays up with "Tap to talk to {name}", no room. |
| `{type: "receptionist-started"}` | embed → page | A session started (any route). |

The AI button also re-reads AIWEB's `enabled` every second, so it stays right
when the tour shows or hides the frame with its own actions (#9).

## 6. Her name

`NEXT_PUBLIC_ASSISTANT_NAME` (default `Mia`), read in `src/lib/assistant.ts`.
Set it in Vercel and redeploy (it is inlined at build time). The name she
*says* is in the worker's prompt and must match.

## 7. Testing without the worker's help

- **Dev server only** (`next dev`): the embed page exposes `window.miaDev`:
  `miaDev.screen({type: "contact_card"})`, `miaDev.caption("mia", "Bonjour")`,
  `miaDev.state("paused")`, `miaDev.language("en")`, `miaDev.end()` (ends the
  session as the worker would → resting). Stripped from production builds.
- **Through LiveKit** (any build): `scripts/mia-screen-push.py` joins a kiosk
  room as an extra participant, pushes `mia.screen` messages, sets `mia.*`
  attributes on itself, and prints the `mia.control` taps it receives. The room
  name is in the browser console (`[SimliLK] in room kiosk-…`). Usage in the
  script's docstring.
