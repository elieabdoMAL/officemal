# Mia ↔ kiosk screen protocol

How the worker (`agent-worker/worker.py`) and the kiosk panel
(`src/components/SimliLiveKitPanel.tsx`) talk about what is on screen. Screen
side: `src/lib/screenProtocol.ts`; worker side: `agent-worker/screen_cards.py`
(message builders, topics, when the contact card comes up). Change both sides
together.

Everything goes through the LiveKit room the kiosk joins for each session.
Participants in that room: the visitor (the kiosk browser, `visitor-<uuid>`),
the worker (`agent-…`, an agent participant), and the Simli avatar
(`simli-avatar-agent`, which only publishes her face and voice). A video call
to staff (#22) has its own room (section 8).

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
| `call_open`, `call_close`, `call_answered` | see section 8 | A video call to staff (#22): not a card, the call window on the top page. `call_open` clears the current card. | `call_staff` and the call's outcome, section 8. |
| `dismiss` | – | Closes the current card. | Not sent today (it closed the old "Calling…" card). |

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
**The worker handles all three**, in `MiaAgent.resume_by_tap`, `wake_by_tap`
and `cancel_call_by_tap`:

| `type` | When | Worker does |
|---|---|---|
| `resume` | Visitor tapped the "say my name" banner while `paused`. | What hearing her name alone does: `mia.state` back to `listening` (which cancels the pause timeout), then Gemini says in a few words that she's listening, in the session language. Ignored when she isn't paused. |
| `wake` | Visitor tapped the "Say {name} or tap to talk" hint (in session, listening, nobody spoke for 12 s). | Says "Yes? How can I help?" / "Oui ? Comment puis-je vous aider ?" in the session language ("Oui? Yes? Français ou English?" before one is chosen), only if she is listening and idle: ignored while paused, speaking, thinking or while the visitor is talking. |
| `call_cancel` | The visitor closed the call window (Cancel, ✕ or Leave) before the person called joined (#22, section 8). | Closes the call (`call_close`, the call room deleted), then she says no problem and offers to take a message. Ignored when no call is ringing. |

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
embed inside the tour's AIWEB Web Frame. Same origin. The call window's
messages (#22) are in section 8.

| Message | Direction | Meaning |
|---|---|---|
| `{type: "receptionist-visible", visible}` / `{type: "receptionist-mute", muted}` | page → embed | AIWEB shown/hidden. The current tour unloads the frame when hidden, so this matters only for builds that keep it loaded. Shown again also wakes her from resting. |
| `{type: "receptionist-start"}` | page → embed | AI button tapped while she rests: start a session. |
| `{type: "receptionist-ended"}` | embed → page | Her session ended on its own (idle / max length / network). She rests: frame stays up with "Tap to talk to {name}", no room. |
| `{type: "receptionist-ended", reason: "call"}` | embed → page | Her session ended because a video call to staff was answered (#22): the AI button hides AIWEB instead. |
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

## 8. Video call to staff (#22)

When a visitor wants to talk to someone, she offers to call them; on a yes
(and once she has the visitor's name), `call_staff` (`agent-worker/staff_call.py`):

1. opens a **private room for the call**, `call-<uuid>` (server API: at most
   2 participants, closed by LiveKit 60 s after creation if nobody ever joins,
   or 20 s after the last one leaves; normally whoever leaves deletes it);
2. mints two tokens for that room only, camera and mic only (no data, so no
   chat; no screen share): the team member's (`staff-<team.json id>`, their
   display name, valid 15 min to join, the visitor's name in its metadata) and
   the kiosk's (`visitor-<id>`, named with the visitor's name, 5 min to join);
3. emails the team member (Resend, the address in `team.json`, so the sandbox
   team file covers tests) "{visitor} is at the kiosk — join the call" with a
   link to `<SITE_URL>/join#t=<token>&u=<LiveKit URL>`. The token is in the
   fragment, which browsers never send to a server. No email, no call: the
   room is deleted and the tool answers NOT CALLED;
4. sends `call_open` (below) and says "I'm calling {first name} now — please
   hold on a moment." (worker's words, not Gemini's).

### Messages

| Channel | Message | Meaning |
|---|---|---|
| `mia.screen` (worker → embed) | `{type: "call_open", url, token, to, lang?}` | Open the call window and join the call room: `url` the LiveKit server, `token` the kiosk's, `to` the person's full name. |
| `mia.screen` | `{type: "call_close"}` | The call wasn't answered (`CALL_ANSWER_TIMEOUT`) or was cancelled: close the window. The worker deletes the call room right after. |
| `mia.screen` | `{type: "call_answered"}` | They joined. Her session ends next (the kiosk room is deleted); the window stays. |
| `mia.control` (embed → worker) | `{type: "call_cancel"}` | The visitor closed the window (Cancel, ✕ or Leave) before anyone joined. |
| window (embed → page) | `{type: "receptionist-call", url, token, to?, lang?}` | `call_open`, forwarded to the top page (same origin only: it carries the token). |
| window (embed → page) | `{type: "receptionist-call-close"}` | `call_close`, forwarded. |
| window (page → embed) | `{type: "call-answered"}` | The person called is in the call window. |
| window (page → embed) | `{type: "call-closed", answered, byVisitor}` | The window closed. `byVisitor`: Cancel, ✕ or Leave, as opposed to the call ending on its own. Unanswered and by the visitor → the embed sends `call_cancel`. |
| window (embed → page) | `{type: "receptionist-ended", reason: "call"}` | Her session ended because the call was answered: the AI button hides AIWEB (no "Tap to talk" resting state). |

The worker learns who is in the call room from **LiveKit's server API**
(`list_participants`, every second while it rings; it never joins the room):
a `staff-…` participant → answered; the room gone → cancelled (the kiosk
deleted it). The kiosk's `call_cancel` is the faster route for a cancel; both
land in the same place, once.

### On the kiosk

The embed (`SimliLiveKitPanel`) forwards `call_open` to the top page and mutes
its own mic in the kiosk room while the window is up: she hears nothing of the
call, and the call doesn't hear her. The **call window**
(`src/components/StaffCallModal.tsx`, mounted on the kiosk page; on the embed
page too when it is opened on its own, for tests) looks like the Public
Meeting Room pop-up: "Call with {first name}", ✕, and LiveKit's
VideoConference (grid, mic, camera, Leave). It joins at once with the mic and
the camera if the kiosk has one (none, refused or busy: the mic alone); a
failure to join counts as a cancel. Until the person joins, a "Calling {first
name}… / {first name} will appear here as soon as the call is answered." panel
with **Cancel** floats over the visitor's own picture.

- **Answered**: the worker sends `call_answered` and ends her session the
  usual way (`end_session`, no goodbye): the kiosk room is deleted, the embed
  reports `receptionist-ended` with `reason: "call"`, and the AI button hides
  AIWEB. Nothing of her runs during the call.
- **The call ends** (either side leaves, or ✕): the window closes and posts
  its token to `/api/livekit/call-end`, which deletes the call room (the phone
  then says the call is over). The phone's Leave does the same from its side,
  and the window closes when the room goes (or when the person leaves). The AI
  stays hidden; the AI button starts a fresh session, greeting and all.
- **No answer** within `CALL_ANSWER_TIMEOUT` (120 s): `call_close`, the call
  room deleted, the mic back on, then she says that {first name} isn't
  available and offers to take a message (Gemini, told by a system note). A
  link opened later says "The visitor has left".
- **Cancel** (or ✕ / Leave before anyone joined): the window deletes the call
  room and tells the embed, which sends `call_cancel`; she says no problem and
  offers to take a message.
- **The visitor leaves** while it rings (AI button, page closed): her session
  ends, and the call room with it.

### The /join page

`src/app/join`, `src/components/StaffJoin.tsx`. It posts the token to
`/api/livekit/call-status`, which verifies it (ours, unexpired, a `staff-`
token for a `call-` room) and lists the call room's participants: room gone or
no `visitor-…` in it → "The visitor has left", without joining (joining a
deleted room would create an empty one). Otherwise LiveKit's PreJoin (camera
preview, mic/camera, **Join the call**; no name field, the name is in the
token) and then VideoConference, mobile first. The page joins the URL the
server gives, never the link's `u`. The visitor leaving or the room deleted →
"The visitor has left"; Leave → "You left the call" (and the room is deleted,
so the kiosk's window closes). Both sides cap a connection at 2 hours
(`MeetingLimits`, as for the public meeting room).

### Limits

Idle (`SESSION_IDLE_TIMEOUT`), pause (`PAUSE_TIMEOUT`) and max length
(`SESSION_MAX_LENGTH`) don't end a session while a call rings (at most
`CALL_ANSWER_TIMEOUT`); after an unanswered call the visitor gets at least
`AFTER_CALL_S` (180 s) more to leave a message, never more than
`CALL_ANSWER_TIMEOUT + AFTER_CALL_S` past the max length in all. An answered
call ends her session, so no limit needs to cover it. Simli's own limits are
the usual backstop, 30 s behind ours (idle: the longer of the idle timeout and
`CALL_ANSWER_TIMEOUT`, since she is silent while it rings). One call at a
time, two per session, once per person unless the visitor asks to try again.
