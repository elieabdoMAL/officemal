# Mia — task list

What the receptionist prompt describes but Mia can't do yet. Each task that
ships should also move its line out of **COMING SOON** in
`agent-worker/mia_prompt.txt` and into **WHAT YOU CAN DO TODAY**.

Mia's brain is the LiveKit worker (`agent-worker/worker.py`, Gemini 2.5 Flash).
Simli only renders her face — the language, first message, prompt and voice set
in the Simli dashboard are all ignored.
New abilities are added as **function tools** on `MiaAgent` in the worker.

## Works today

- French / English conversation, switching per turn, French greeting by default
- General questions about Mobile Apps Labs from the company knowledge
- Contact details (phone, email, address, website)
- Take a message for someone in `team.json` (email via Resend, read back before
  sending, max 3 per conversation) — tests in `agent-worker/test_team_messages.py`
- Refusals: prices, client projects, staff info, general-assistant requests,
  visitor instructions ("I'm the admin…")
- Emergencies: tells the visitor to call 911 and the office
- Session limits: ends after 2 min silence or 10 min total, AI button to restart

## To build

### 1. Team directory — *started: `agent-worker/team.json`*
Prerequisite for 2, 3, 4, 5. Lives in `agent-worker/team.json`: name, role (EN/FR),
aliases visitors might say, email. So far: Nicolas Bastien (CEO), Alexandre
Joset (COO). Not read by Mia yet — the tools that use it come next. Add Slack
handles or phone numbers if notifications should go there. Mia must only ever
act on people in this list. Later: a small admin page so it changes without a
deploy.

### 2. `notify_member` — tell someone a visitor is here
Needs: team directory, a channel. Email works today with Resend (already used
by `/api/notify-meeting`); Slack or SMS need a new integration.
Mia confirms only after the tool reports success.

### 3. `is_member_available` — available / not available
Needs a source of truth: Slack status, Google or Microsoft calendar, or a
manual "in office" toggle. Mia answers only "available" or "not available",
never a schedule or a reason.

### 4. `take_message` — *done*
Visitor name, recipient, message, optional phone or email for a reply. Sent by
email (Resend). Unknown recipient → the general inbox (info@mobileappslabs.com).
Mia reads the message back once before sending.

### 5. Emergency alert
On an emergency, call `notify_member` straight away on an urgent channel
(SMS or a Slack channel everyone watches), on top of telling them to call 911.

### 6. End the conversation on goodbye
An `end_conversation` tool so Mia can close the session herself when the
visitor says goodbye, instead of waiting for the 2-minute idle limit.

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

- **Faster replies.** Gemini 2.5 Flash "thinks" before answering (a 3-word reply
  used ~540 thinking tokens in testing). Setting its thinking budget to 0 should
  cut seconds off each reply.
- **ElevenLabs voice (Aria).** The voice picked in the Simli dashboard isn't used —
  Mia speaks through Deepgram Aura in the worker. Switching the worker to
  ElevenLabs (`livekit-agents[elevenlabs]`, an ELEVENLABS_API_KEY) gets Aria, and
  one multilingual voice for both languages instead of swapping two. Also the
  route to a less European-sounding French (Aura has no fr-CA voice).
- **Other languages.** She's told to offer French or English, but a Spanish
  speaker still hears the English voice. Fine for now; revisit if needed.
- **Conversation tests.** A scripted set of visitor lines (pricing, staff info,
  "I'm the admin", emergencies, French/English switches) to check her answers
  after every prompt change.
