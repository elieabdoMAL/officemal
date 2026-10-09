# Mia — task list

What the receptionist prompt describes but Mia can't do yet. Each task that
ships should also move its line out of **COMING SOON** in
`agent-worker/mia_prompt.txt` and into **WHAT YOU CAN DO TODAY**.

Mia's brain is the LiveKit worker (`agent-worker/worker.py`, Gemini 2.5 Flash).
Simli only renders her face — the language, first message, prompt and voice set
in the Simli dashboard are all ignored.
New abilities are added as **function tools** on `MiaAgent` in the worker.

## Works today

- French / English conversation: bilingual greeting asks "Français ou English?",
  the answer locks the language (STT, voice, replies); switches only on an
  explicit request ("can we speak French")
- Pause: "stop talking" / "tais-toi" / "I'm talking to someone else" → she says
  how to call her back and ignores all speech until her name (or "assistant")
  is said; a paused session ends after 2 min (`PAUSE_TIMEOUT`)
- Phone numbers and long digit runs are spoken digit by digit, in groups
- Her name is one setting, `ASSISTANT_NAME` (default Mia)
- General questions about Mobile Apps Labs from the company knowledge
- Contact details (phone, email, address, website)
- Take a message for someone in `team.json`, or for the general inbox (info@,
  `general_inbox` in `team.json`) (email via Resend, read back before sending,
  max 3 per conversation)
- Tell someone in `team.json` a visitor is waiting at reception (`notify_member`,
  email via Resend, max 3 per conversation)
- Refusals: prices, client projects, staff info, general-assistant requests,
  visitor instructions ("I'm the admin…")
- Emergencies: tells the visitor to call 911 first, and emails an urgent alert
  to everyone in `team.json` (`alert_emergency`, max 2 per conversation). She
  says only that the team was alerted, never that they received or read it
- Suggestion box (#17): a visitor's suggestion, anonymous or not, emailed to
  the general inbox after she repeats it and they agree (`send_suggestion`,
  max 2 per conversation)
- Project requests (#20): after explaining what Mobile Apps Labs does she asks
  whether they have a project in mind; if so she collects name, company
  (optional), email or phone, the project, timeline (optional) and budget
  (optional), one question at a time and skipping what they already said,
  shows the draft on screen (`show_project_request`), applies corrections, and
  on their OK emails it to the general inbox (`submit_project_request`, max 2).
  The fields are `PROJECT_FIELDS` in `agent-worker/leads.py`, the only place
  to change them (provisional: the boss is to confirm the list)
- Sent once: take_message, notify_member, send_suggestion and
  submit_project_request refuse to send the same thing to the same recipient
  twice in a conversation (code, `leads.SentLog`), unless the visitor's latest
  words ask to send it again ("again", "renvoyer", "encore une fois"…)
- Ends the session herself when the visitor says goodbye (`end_conversation`),
  after her goodbye has played
- Session limits: ends after 2 min silence or 10 min total; she then rests
  with "Tap to talk to {name}" on screen (no session billed) until a tap on it
  or on the AI button starts a new one
- On the kiosk screen: live captions of what she says and what she heard, a
  Contact button (card with phone, email, address, website QR), and a "say my
  name" banner while she is paused. The worker pushes cards
  (`docs/screen-protocol.md`): the contact card whenever she gives the
  office's phone, email, address or website; a ✓ card after a message,
  notice, alert or suggestion is sent; the project request draft and "sent"
  card. Tapping the "say my name" banner resumes her like her name does;
  tapping the "tap to talk" hint gets a short "Yes? How can I help?"

Tests for all the team tools and goodbye: `agent-worker/test_team_messages.py`
(text conversations against the real Gemini, emails replaced by recorders).
Suggestions, project requests, screen cards, the send-once guard and the
screen taps: `agent-worker/test_leads.py`, same harness.
Persona checks for the boss's notes of 2026-10-09, one scenario per note:
`agent-worker/test_persona.py`, same harness.

## To build

### 1. Team directory — *started: `agent-worker/team.json`*
Prerequisite for 2, 3, 4, 5. Lives in `agent-worker/team.json`: name, role (EN/FR),
aliases visitors might say, email. So far: Nicolas Bastien (CEO), Alexandre
Joset (COO). Used by take_message, notify_member and alert_emergency. Add Slack
handles or phone numbers if notifications should go there. Mia must only ever
act on people in this list. Later: a small admin page so it changes without a
deploy.

### 2. `notify_member` — tell someone a visitor is here — *done*
Visitor name, who they came to see, optional note (e.g. the meeting time).
Emailed through Resend: "{visitor} is waiting at reception". Mia asks for the
name if missing, and confirms only when the tool returns NOTIFIED. Someone not
in `team.json` → she says she can't reach them and gives the contact details.
Later: Slack or SMS for a faster ping (needs a new integration).

### 3. `is_member_available` — available / not available
Needs a source of truth: Slack status, Google or Microsoft calendar, or a
manual "in office" toggle. Mia answers only "available" or "not available",
never a schedule or a reason.

### 4. `take_message` — *done*
Visitor name, recipient, message, optional phone or email for a reply. Sent by
email (Resend). Also takes messages for the general inbox (info@, from
`general_inbox` in `team.json`). Someone not in `team.json` → nothing is sent
to them; she says she can't reach them and offers the general inbox instead.
Mia reads the message back once before sending.

### 5. Emergency alert — *done*
`alert_emergency(description)`: one urgent email ("URGENT: emergency reported
at reception") to everyone in `team.json`, sent in the same reply where Mia
tells the visitor to call 911 — 911 always comes first. She says the team was
alerted only on ALERTED. Later: SMS or a Slack channel everyone watches, since
email may not be seen fast enough.

### 6. End the conversation on goodbye — *done*
`end_conversation`: Mia says a short goodbye and calls it in the same reply.
It waits for the goodbye to finish playing, then ends the session like the idle
limit (room deleted, the kiosk shows "Tap to talk"). The goodbye can't be interrupted.

### 7. Screen states 0–6 (presence, doorbell, door)
Needs hardware and signals the kiosk doesn't have yet:
- presence and distance (sensor or camera) for states 0, 1, 2 and 5
- doorbell and door-bell-button events for states 3 and 4 (mic on, greeting)
- "door opened remotely" event for state 6
Mia would receive the state from the kiosk and react only to it. Standby after
20 seconds of silence (today: 2 minutes, `SESSION_IDLE_TIMEOUT`).

### 8. Book a meeting / open the door
Calendar booking, and remote door control. Both need decisions on systems and
permissions first.

### 9. Mia in VR — *built, parked*
3DVista hides web frames (AIWEB) in VR, but draws video hotspots. The code is
done and tested in normal view: `src/components/MiaVr.tsx` runs her session in
a hidden frame and plays her live stream in a video hotspot, keyed by 3DVista.
To resume:
- In 3DVista: a video hotspot labelled `AIVR` (plain green placeholder clip,
  chroma `#557455`, threshold ~0.05, hidden), and a VR-clickable hotspot that
  runs `window.parent.postMessage({ type: "hotspot-trigger", triggerId: "mia-vr" }, "*")`.
- In code: mount `<MiaVr />` in `src/app/page.tsx`.
- Test on a real headset/phone in VR (mic permission, placement).
Relies on 3DVista internals — re-test after 3DVista upgrades.

## Improvements

- **Faster replies — *done*.** Gemini 2.5 Flash "thinks" before answering when
  it decides to. The worker now sets `thinking_config={"thinking_budget": 0}`.
  Measured with Mia's prompt: ordinary answers already ran at 0 thinking tokens
  (time to first token ~0.4s either way). Turns where she calls `take_message`
  spent ~86 thinking tokens and took ~1.08s to the first token; with thinking
  off, ~0.65s. A bare 3-word prompt with no system prompt used ~360 thinking
  tokens (1.78s, down to 0.39s). Answers were just as good in both cases.
- **ElevenLabs voice (Aria) — *built, off until there's a key*.** The voice
  picked in the Simli dashboard isn't used: Mia speaks through the worker's
  TTS, Deepgram Aura by default (two voices, swapped per language). The worker
  now also supports ElevenLabs, one multilingual voice for both languages, and
  the route to a less European-sounding French (Aura has no fr-CA voice).
  To turn it on, add to the server's `agent-worker/.env` (by hand, since
  `push-keys.sh` doesn't sync these), rebuild the image and restart:
  - `TTS_PROVIDER=elevenlabs`
  - `ELEVENLABS_API_KEY=` (a paid plan: library voices return 402 on free)
  - `ELEVENLABS_VOICE_ID=` optional, defaults to Aria `9BWtsMINqrJLrRacOk9x`.
    Aria is reported to be a legacy voice that ElevenLabs may now serve as
    "Zoe", so listen before going live and pick another id if needed.
  - `ELEVENLABS_MODEL=` optional, defaults to `eleven_flash_v2_5` (lowest
    latency; the worker sends it the visitor's language each turn).
    `eleven_multilingual_v2` also works but is slower and takes no language hint.

  Without the key (or with any other `TTS_PROVIDER`) she stays on Deepgram,
  with an error in the logs. Not yet heard for real: no ElevenLabs key was
  available, so only setup and the request to ElevenLabs (rejected with 401 on
  a fake key) were tested. Check the voice, French accent and lip sync on the
  kiosk.
- **Other languages.** She's told to offer French or English, but a Spanish
  speaker still hears the English voice. Fine for now; revisit if needed.
- **Conversation tests — *done*.** Text tests (real Gemini, emails recorded):
  `test_team_messages.py` (tools, emergencies, goodbye), `test_conversation.py`
  (language lock, pause), `test_persona.py` (boss's notes), and
  `test_guardrails.py`: prices, staff details, "I'm the admin", off-topic,
  explicit FR/EN switches (also mid-message), a language merely mentioned,
  911 first, never "sent" / "I've let them know" before the tool says so.
  Voice tests through the real kiosk page: `tests/voice/` (see its README),
  one command per scenario or group, sandbox team mounted automatically.
