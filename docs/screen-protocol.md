# Screen protocol: worker ↔ kiosk screen

How the LiveKit worker (`agent-worker/worker.py`) and the kiosk page
(`src/`) tell each other things beyond audio and video. Each side documents
what it sends; the other side codes against it. Change a section only together
with the code that implements it.

## Worker → screen: participant attributes (Chat C)

The worker sets these on **its own participant** (the agent, not the Simli
avatar participant that publishes her video). Values are always strings.

| Attribute | Values | Meaning |
|---|---|---|
| `mia.state` | `listening` · `speaking` · `paused` | `paused`: the visitor told her to stop talking (#24, #25); she ignores all speech until her name is said. `speaking`: her reply is playing. `listening`: everything else, including while she works out a reply. |
| `mia.language` | `fr` · `en` | The conversation language once the visitor has chosen it (#23). **Absent** before the choice (she has just greeted in both: "Bonjour, hello! Français ou English?"). Changes only when the visitor explicitly asks to switch. |
| `mia.name` | e.g. `Mia` | Her name (env `ASSISTANT_NAME`, default `Mia`; the boss may rename her). Use it in on-screen text such as "Say Mia to talk to me". |

`mia.state` and `mia.name` are set as soon as she joins, `mia.language` once
chosen; only changed attributes are re-sent.

Notes for the screen:
- Find her by the attribute, not by identity: on join read
  `participant.attributes` of each remote participant, then listen to
  `RoomEvent.ParticipantAttributesChanged` and keep the participant whose
  attributes contain `mia.state`.
- `paused` wins over `speaking`: the line she says when pausing ("No problem,
  I'll stop talking. If you want to talk to me, just say my name, Mia.") plays
  while `mia.state` is already `paused`. Suggested UI: a clear "Say «Mia» to
  talk to me" / "Dites «Mia» pour me parler" state, in `mia.language`.
- While `paused`, the visitor's speech still shows up in LiveKit user
  transcriptions (she has to listen for her name). Consider hiding the
  visitor's captions while paused: it's usually a conversation with someone
  else, not with her.
- A paused session ends after `PAUSE_TIMEOUT` seconds (default 120, same as
  the idle limit) unless her name is said: the worker deletes the room, as for
  idle. Speech she ignores while paused does not keep the session alive.
- Finer agent state (`initializing`, `thinking`, ...) is also available in
  LiveKit's own `lk.agent.state` attribute on the same participant.
- Captions show her text as written: a phone number she writes as
  "514 573 2324" is captioned with digits but spoken digit by digit (#6).

## Screen → worker

(Not used yet. Chat S: add your messages here, e.g. data-channel topics.)
