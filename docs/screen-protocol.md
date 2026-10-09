# Mia ↔ kiosk screen protocol

How the worker (`agent-worker/worker.py`) and the kiosk panel
(`src/components/SimliLiveKitPanel.tsx`) talk about what is on screen. Screen
side: `src/lib/screenProtocol.ts`; worker side: `agent-worker/screen_cards.py`
(message builders, topics, when the contact card comes up). Change both sides
together.

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
| | `speaking` | Her reply is playing. The screen treats it like `listening` (the pill already follows who is speaking). |
| | `paused` (#24, #25) | Big banner "My name is {name} — say my name to talk to me" in place of the pill. The visitor's captions are hidden (they're talking to someone else). Tapping the banner sends `resume` (section 4). `paused` wins over `speaking`: her "No problem, I'll stop talking…" line plays while the state is already `paused`. |
| `mia.language` | `fr` / `en` | The conversation language once the visitor chose it (#23); changes only on an explicit request to switch. Language of the banners, card labels and caption labels. **Absent** before the choice (she greets in both, "Bonjour, hello! Français ou English?"): the screen shows both (French first). |
| `mia.name` | e.g. `Mia` | Her name, from the worker's `ASSISTANT_NAME`. The screen currently uses `NEXT_PUBLIC_ASSISTANT_NAME` (section 6); the two must match. |

Missing attribute = `listening`; any unknown state is shown as `listening`.
`mia.state` and `mia.name` are set when she joins, `mia.language` once chosen;
only changed attributes are re-sent, and setting one leaves the others alone.

- Find her by attribute, not identity: read `participant.attributes` of each
  remote participant on join, then follow `RoomEvent.ParticipantAttributesChanged`
  and keep the participant whose attributes contain `mia.state`.
- A paused session ends after `PAUSE_TIMEOUT` seconds (default 120) unless
  her name is said: the worker deletes the room, as for idle. Speech she
  ignores while paused doesn't keep the session alive.
- LiveKit's own `lk.agent.state` attribute (`initializing`, `thinking`, …) is
  on the same participant if finer state is ever needed.

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

**The worker sends all of these (wave 2, Chat L)**, one at a time and in
order; a failed send is logged and never interrupts the conversation. One text
stream per message, body is JSON with a `type`:

```python
await ctx.room.local_participant.send_text(
    json.dumps({"type": "message_sent", "kind": "message", "to": "Nicolas Bastien"}),
    topic="mia.screen",
)
```

| `type` | Fields | Screen | The worker sends it |
|---|---|---|---|
| `contact_card` | `lang?` | Card on the right of the frame: phone, email, address, website, QR code to the website. Closes after 45 s or on ×. Same card as the panel's Contact button. | When her words give the office's phone, email, address or website (`gives_contact_details`, checked in `transcription_node`, so only for speech that is actually played; once per reply). The visitor's own 514 number or email read back doesn't count. Skipped while another card of hers is up (a `message_sent` for 10 s, a draft `project_request` for 180 s), so "you can also call us at…" never replaces them. |
| `message_sent` | `kind?`, `to?`, `lang?` | Green ✓ card, closes after 10 s. Text by `kind`: `message` "Message sent to {to}", `notify` "{to} has been told you're here", `alert` "The team has been alerted", `suggestion` "Suggestion sent — thank you!", `project_request` "Project request sent". Without `to`: "Message sent" / "The team has been told you're here". | When the tool succeeds, before she says so (#3): `take_message` → SENT (`kind` `message`, `to` the person's name, or the general inbox's name in her language: "the general inbox" / "la boîte de réception générale"), `notify_member` → NOTIFIED (`notify`, `to` the person), `alert_emergency` → ALERTED (`alert`, no `to`), `send_suggestion` → SENT (`suggestion`). Again when a tool refuses a repeat send ("already sent"), since it is. A project request uses its own card (below), not `kind: project_request`. |
| `project_request` | `status`, `fields`, `lang?` | The project request form (#20), see below. | `show_project_request` (`draft`) and `submit_project_request` (`sent`). |
| `dismiss` | – | Closes the current card. | Not used yet. |

`lang` (`fr`/`en`) overrides `mia.language` for that card. The worker always
sets it to the session language once the visitor has chosen one, and leaves it
out before. `to` is shown as given (keep it to a display name: "Nicolas
Bastien", not an email address).
One card at a time: a new one replaces the current one. Unknown types and bad
JSON are ignored (logged in the browser console), so the worker can start
sending a new type before the screen draws it.

### The project request card (#20)

```json
{"type": "project_request", "status": "draft",
 "fields": {"name": "Ana Silva", "company": "Pain Doré", "email": "ana@paindore.ca", "phone": "",
            "description": "A loyalty app for my bakery", "timeline": "Within three months", "budget": ""},
 "lang": "en"}
```

- `draft`: "Your project request" with every field (blank ones as "—") and
  "Please check it and tell {name} what to change", amber top edge. Stays up
  180 s (each update restarts that) while the visitor reads it and she applies
  corrections; she sends a new draft after each correction.
- `sent`: green ✓ "Project request sent", only the filled fields, "The team
  will get back to you". Closes after 15 s.
- `fields` is drawn in the order received. The field list lives in one place,
  `PROJECT_FIELDS` in `agent-worker/leads.py` (provisional until the boss
  confirms it); the screen has labels for the seven above and shows any other
  key under its own name (`extra_field` → "extra field") until it gets one in
  `PROJECT_LABEL` (`src/components/MiaScreenCards.tsx`). Values are capped at
  600 characters; the description is clamped to 4 lines, other values to 2.
- Any card, and so a draft holding the visitor's name, email and phone, is
  cleared when the session ends: it never waits for the next visitor.

## 4. Taps: `mia.control` (screen → worker)

The screen sends one text stream per tap, JSON with a `type`, to the room.
**The worker handles both (wave 2, Chat L)**, in `MiaAgent.resume_by_tap` and
`wake_by_tap`:

| `type` | When | Worker does |
|---|---|---|
| `resume` | Visitor tapped the "say my name" banner while `paused`. | What hearing her name alone does: `mia.state` back to `listening` (which cancels the pause timeout), then Gemini says in a few words that she's listening, in the session language. Ignored when she isn't paused. |
| `wake` | Visitor tapped the "Say {name} or tap to talk" hint (in session, listening, nobody spoke for 12 s). | Says "Yes? How can I help?" / "Oui ? Comment puis-je vous aider ?" in the session language ("Oui? Yes? Français ou English?" before one is chosen), only if she is listening and idle: ignored while paused, speaking, thinking or while the visitor is talking. |

```python
def on_control(reader, participant_identity):
    async def read():
        msg = json.loads(await reader.read_all())
        ...
    asyncio.create_task(read())

ctx.room.register_text_stream_handler("mia.control", on_control)
```

Unknown types and bad JSON are logged and ignored.

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
