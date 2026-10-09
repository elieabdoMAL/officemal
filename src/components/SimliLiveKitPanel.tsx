"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";
import { applyChromaKey } from "@/lib/chromaKey";
import { asLang, type Lang } from "@/lib/assistant";
import {
  ATTR_LANGUAGE,
  ATTR_SEGMENT_ID,
  ATTR_STATE,
  ATTR_TRANSCRIPTION_FINAL,
  TOPIC_CONTROL,
  TOPIC_SCREEN,
  TOPIC_TRANSCRIPTION,
  asMiaState,
  parseScreenMessage,
  type ControlMessage,
  type MiaState,
  type ScreenMessage,
} from "@/lib/screenProtocol";
import MiaCaptions, { useCaptions, type Speaker } from "@/components/MiaCaptions";
import MiaScreenCard, { ContactButton, type Card } from "@/components/MiaScreenCards";
import MiaBanner from "@/components/MiaBanner";

// Simli Trinity receptionist over LiveKit. Unlike SimliReceptionistPanel (which
// used Simli Auto + Daily, a Legacy-only pipeline), this joins a LiveKit room
// where a self-hosted worker (agent-worker/) renders the Trinity face.
//
// Behaviour mirrors the Daily panel:
//   - On load: get a token from /api/livekit/token, join the room, show the
//     avatar, and let the worker speak its first message on its own. Mic starts
//     MUTED so she greets without listening.
//   - Once her greeting has finished, the mic opens and STAYS open: she
//     listens continuously and the worker's VAD decides when a turn ends. When
//     the transcript is too weak to act on, the worker answers "I'm sorry, I
//     didn't get that."
//   - A session lives only while she's shown. Hiding the frame (AI button, a
//     3DVista action) leaves the room, which ends the session server-side;
//     showing it again starts a fresh one, greeting and all. The current tour
//     build unloads the Web Frame when AIWEB is disabled and loads it again
//     when enabled (seen 2026-10-09), which does the same on its own; the
//     "receptionist-visible" messages cover builds that only hide it.
//   - The worker ends sessions on its own (2 min idle / 10 min max) by deleting
//     the room. She then rests (#9): the frame stays up with a "Tap to talk to
//     {name}" button and no room, so nothing is billed until someone taps it
//     (or the AI button) and a fresh session starts. The top page is told, so
//     the AI button shows she's off.
//
// On top of her (docs/screen-protocol.md): live captions from LiveKit's
// transcription streams (#16), a Contact button and the cards the worker can
// push on "mia.screen" (#18), and the "say my name" banner while she's paused
// (#24, #25), from the worker's "mia.state" / "mia.language" attributes.

type Status = "idle" | "connecting" | "ready" | "speaking" | "error";

// What the visitor is told is happening right now. Kept separate from Status
// (which tracks the connection) because a visitor standing at a kiosk needs to
// know whose turn it is, not whether a room is joined.
type Turn =
  | "waiting" // mic open, silence — her cue for "go ahead"
  | "hearing" // the visitor is speaking into the open mic
  | "thinking" // visitor stopped, reply not started yet
  | "answering"; // she's talking

const TURN_LABEL: Record<Turn, { text: string; bg: string }> = {
  waiting: { text: "🎙️ Go ahead — I'm listening", bg: "rgba(0,0,0,0.55)" },
  hearing: { text: "● Listening…", bg: "rgba(239,68,68,0.9)" },
  thinking: { text: "… Thinking", bg: "rgba(234,179,8,0.9)" },
  answering: { text: "🔊 Speaking", bg: "rgba(0,150,255,0.85)" },
};

const TURNS = Object.keys(TURN_LABEL) as Turn[];

type Props = {
  autoStart?: boolean;
  // Chroma-key the avatar's studio background to transparent so she stands
  // directly in the panorama. On by default; pass chromaKey={false} to show the
  // raw video (backdrop square) — useful when checking a new face's backdrop.
  chromaKey?: boolean;
};

// Backdrop removal lives in @/lib/chromaKey — see the note there on why this
// keys by chroma distance rather than hue+saturation. Whenever SIMLI_FACE_ID
// changes, re-check the backdrop colour: a face on a different colour needs
// KEY_COLOR updated, or she shows up in a coloured box.

// The mic stays shut until her greeting has finished, so her own voice doesn't
// land in her ears and a visitor who speaks straight away doesn't talk over
// it. A fixed delay (it was 6s) wasn't enough: the avatar often starts late,
// the mic opened mid-greeting, the visitor's first words interrupted her, and
// their question could be lost entirely. So we wait for the avatar to stop
// speaking, which LiveKit reports through active-speaker events.
//
// "Stopped" means quiet for this long. Speaker events lag the audio (~0.5s
// to report silence, ~1s to report speech again), and the greeting has a
// ~0.7s pause between its two sentences: at 800ms the mic opened during the
// second one in testing. 1.5s rides out that pause; the mic opens ~2s after
// her last word.
const GREETING_PAUSE_MS = 1500;
// Fallback from joining in case speaker events never come (or she never
// speaks), so the mic can't stay shut for good. In testing her greeting ended
// 8-10s after joining (the avatar takes a few seconds to start) and was seen
// as over ~2s later; 12s fired before that once, so this leaves room.
const GREETING_FALLBACK_MS = 20000;

// Longest we'll claim she's "thinking" before admitting we're back to waiting.
const THINKING_TIMEOUT_MS = 8000;

// Nobody has spoken for this long: swap "Go ahead — I'm listening" for the
// "Say {name} or tap to talk" hint.
const IDLE_HINT_MS = 12000;

// Cards close on their own: the next visitor shouldn't find the last one's.
const CARD_MS: Record<Card["type"], number> = { contact_card: 45000, message_sent: 10000 };

// How much to enlarge her within the Web Frame. Simli renders her small inside
// a 16:9 feed and objectFit "contain" letterboxes that, so she reads as a
// distant figure at kiosk distance. Scaling here rather than resizing the
// hotspot in 3DVista keeps her anchored to the same spot in the panorama.
// Above ~1.5 the crop starts cutting her shoulders — raise the Web Frame's
// height in 3DVista instead if she needs to be bigger than that.
const AVATAR_SCALE = 1.05;

// Module-level lock. React Strict Mode (dev) mounts effects twice; this ensures
// only ONE room connection is ever starting/alive across remounts.
let SESSION_ACTIVE = false;

export default function SimliLiveKitPanel({
  autoStart = true,
  chromaKey = true,
}: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [hidden, setHidden] = useState(false);
  // Session over (idle / max length / network), frame still up: no room,
  // "Tap to talk" shown until someone taps.
  const [resting, setResting] = useState(false);
  const [turn, setTurn] = useState<Turn>("waiting");
  const [miaState, setMiaState] = useState<MiaState>("listening");
  const [lang, setLang] = useState<Lang | null>(null);
  const langRef = useRef<Lang | null>(null);
  langRef.current = lang;
  const [card, setCard] = useState<Card | null>(null);
  const [idleHint, setIdleHint] = useState(false);
  const [idleTick, setIdleTick] = useState(0); // bumped to restart the idle wait
  const { captions, update: updateCaption, clear: clearCaptions } = useCaptions();
  // miaDev.state()/language() (dev only, below): win over the real attributes.
  const devAttrs = useRef<{ state?: string; language?: string }>({});

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const roomRef = useRef<Room | null>(null);
  const readyRef = useRef(false); // true once joined, so PTT can toggle the mic

  const setMic = useCallback((on: boolean) => {
    const room = roomRef.current;
    if (!room || !readyRef.current) return;
    room.localParticipant
      .setMicrophoneEnabled(on)
      .then(() => {
        setListening(on);
        console.log("[SimliLK] mic set ->", on);
      })
      .catch((e) => console.warn("[SimliLK] setMicrophoneEnabled failed:", e));
  }, []);

  // She listens the whole time she's on screen: mic opens when shown, closes
  // when hidden, and stays open in between (the worker's VAD decides when a
  // turn ends). The only wait is for her greeting at the start of each session
  // (greetingOver, set from the active-speaker events in the connection
  // effect), with GREETING_FALLBACK_MS as a backstop. Browser echo
  // cancellation covers the rest of the session.
  const greetedRef = useRef(false);
  const [greetingOver, setGreetingOver] = useState(false);
  useEffect(() => {
    if (status !== "ready" || hidden) return;

    if (greetedRef.current || greetingOver) {
      greetedRef.current = true;
      setMic(true);
      return;
    }
    const timer = window.setTimeout(() => {
      console.warn("[SimliLK] greeting end not seen, opening mic anyway");
      greetedRef.current = true;
      setMic(true);
    }, GREETING_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [status, hidden, greetingOver, setMic]);

  // The panorama can hide this Web Frame (AiToggle button / a 3DVista action).
  // If hiding doesn't unload the iframe, `hidden` is what ends the session (see
  // the connection effect) and starts a new one when she's shown again. Being
  // shown again is a fresh start, so it also wakes her from resting.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; visible?: boolean; muted?: boolean };
      if (data?.type === "receptionist-visible" && typeof data.visible === "boolean") {
        setHidden(!data.visible);
        if (data.visible) setResting(false);
      } else if (data?.type === "receptionist-mute" && typeof data.muted === "boolean") {
        setHidden(data.muted);
      } else if (data?.type === "receptionist-start" && e.origin === window.location.origin) {
        // AI button tapped while she rests: same as tapping "Tap to talk".
        setHidden(false);
        setResting(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Tell the top page (AiToggle) whether a session is on, so its icon matches.
  // Same origin only: the kiosk page and this embed are one Next app.
  const tellTop = useCallback((type: "receptionist-ended" | "receptionist-started") => {
    try {
      window.top?.postMessage({ type }, window.location.origin);
    } catch {}
  }, []);

  // A message the worker pushed on "mia.screen" (or the Contact button, or the
  // dev hook below). The card takes her current language unless it names one.
  const showScreenMessage = useCallback((m: ScreenMessage) => {
    console.log("[SimliLK] screen message:", m.type);
    if (m.type === "dismiss") setCard(null);
    else if (m.type === "contact_card") setCard({ type: "contact_card", lang: m.lang ?? langRef.current });
    else
      setCard({
        type: "message_sent",
        kind: m.kind ?? "message",
        to: m.to,
        lang: m.lang ?? langRef.current,
      });
  }, []);

  useEffect(() => {
    if (!card) return;
    const timer = window.setTimeout(() => setCard(null), CARD_MS[card.type]);
    return () => window.clearTimeout(timer);
  }, [card]);

  // Screen -> worker (TOPIC_CONTROL). Fire and forget: a worker that doesn't
  // handle a message yet just ignores it.
  const sendControl = useCallback((msg: ControlMessage) => {
    const room = roomRef.current;
    if (!room || !readyRef.current) return;
    room.localParticipant
      .sendText(JSON.stringify(msg), { topic: TOPIC_CONTROL })
      .then(() => console.log("[SimliLK] control sent:", msg.type))
      .catch((e) => console.warn("[SimliLK] control send failed:", e));
  }, []);

  // The idle hint: in a session, she's listening, and nobody has spoken for
  // IDLE_HINT_MS. Any turn change (or a tap on the hint) restarts the wait.
  useEffect(() => {
    setIdleHint(false);
    if (hidden || resting || !listening || miaState !== "listening" || turn !== "waiting") return;
    const timer = window.setTimeout(() => setIdleHint(true), IDLE_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [hidden, resting, listening, miaState, turn, idleTick]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = hidden;
    if (hidden) setMic(false);
  }, [hidden, setMic]);

  // "Thinking" is inferred from silence, so nothing guarantees it ends — a
  // rejected turn ("I didn't get that" never reaches the LLM) or a dropped
  // reply would strand it. Fall back to waiting so the pill can't lie.
  useEffect(() => {
    if (turn !== "thinking") return;
    const timer = window.setTimeout(() => setTurn("waiting"), THINKING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [turn]);

  // Chroma-key paint loop: draw the avatar video to a canvas every frame and
  // knock out the studio backdrop so she stands directly in the panorama.
  // Skipped entirely when chromaKey is false (video shown directly) — useful
  // for eyeballing a new face's backdrop colour.
  useEffect(() => {
    if (!chromaKey) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    const paint = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;

        ctx.drawImage(video, 0, 0, w, h);
        let frame: ImageData;
        try {
          frame = ctx.getImageData(0, 0, w, h);
        } catch {
          // Canvas tainted (cross-origin video) — can't read pixels. Bail out
          // of keying so we don't spin; the raw video element still shows.
          rafRef.current = requestAnimationFrame(paint);
          return;
        }
        applyChromaKey(frame.data, w, h);

        ctx.putImageData(frame, 0, 0);
      }
      rafRef.current = requestAnimationFrame(paint);
    };

    rafRef.current = requestAnimationFrame(paint);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [chromaKey]);

  // One session per showing: runs while shown, torn down (room left) when
  // hidden. The worker sees the visitor leave and deletes the room.
  useEffect(() => {
    if (!autoStart || hidden || resting) return;

    let cancelled = false;
    let localRoom: Room | null = null;
    // Each session opens with her greeting, so the mic waits for it again.
    greetedRef.current = false;
    setGreetingOver(false);
    setTurn("waiting");
    setMiaState(asMiaState(devAttrs.current.state));
    setLang(asLang(devAttrs.current.language));
    // Her greeting is over once she has spoken and then stayed quiet for
    // GREETING_PAUSE_MS (see the ActiveSpeakersChanged handler below).
    let avatarHasSpoken = false;
    let greetingQuietTimer: number | null = null;
    const clearGreetingQuietTimer = () => {
      if (greetingQuietTimer !== null) window.clearTimeout(greetingQuietTimer);
      greetingQuietTimer = null;
    };

    const attachTrack = (
      el: HTMLMediaElement | null,
      track: RemoteTrack
    ) => {
      if (!el) return;
      track.attach(el);
      el.play().catch((e) => console.warn("[SimliLK] media play() blocked:", e));
    };

    const start = async () => {
      if (SESSION_ACTIVE) {
        console.log("[SimliLK] session already active, skipping duplicate start");
        return;
      }
      SESSION_ACTIVE = true;
      setStatus("connecting");
      setErrorMsg(null);
      try {
        const res = await fetch("/api/livekit/token", { method: "POST" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error || `Token request failed: ${res.status}`);
        }
        const { token, url } = await res.json();
        if (cancelled) return;
        if (!token || !url) throw new Error("No token/url returned");
        console.log("[SimliLK] joining LiveKit:", url);

        const room = new Room();
        localRoom = room;

        room.on(
          RoomEvent.TrackSubscribed,
          (
            track: RemoteTrack,
            _pub: RemoteTrackPublication,
            _participant: RemoteParticipant
          ) => {
            if (cancelled) return;
            console.log("[SimliLK] track subscribed:", track.kind);
            if (track.kind === Track.Kind.Video) {
              attachTrack(videoRef.current, track);
              setStatus("ready");
            } else if (track.kind === Track.Kind.Audio) {
              attachTrack(audioRef.current, track);
            }
          }
        );

        // Fires only when the room ends without us leaving it: the worker hit
        // its idle/max limit and deleted the room, or the network gave out past
        // what livekit-client's own reconnect can recover. Either way she's
        // gone: rest (no room, "Tap to talk") and tell the top page.
        room.on(RoomEvent.Disconnected, (reason) => {
          if (cancelled) return;
          console.warn("[SimliLK] room ended:", reason);
          tellTop("receptionist-ended");
          setResting(true);
        });

        // Live captions (#16). AgentSession publishes both sides on
        // lk.transcription: her words as one stream per reply, written a few
        // words at a time in step with her audio; the visitor's (sent with the
        // visitor's identity) as one stream per update, each the whole phrase
        // so far, the last marked final.
        room.registerTextStreamHandler(TOPIC_TRANSCRIPTION, async (reader, { identity }) => {
          const who: Speaker = identity === room.localParticipant.identity ? "visitor" : "mia";
          const attrs = reader.info.attributes ?? {};
          const id = attrs[ATTR_SEGMENT_ID] ?? reader.info.id;
          try {
            if (who === "visitor") {
              const text = await reader.readAll();
              if (!cancelled) updateCaption(who, id, text, attrs[ATTR_TRANSCRIPTION_FINAL] === "true");
              return;
            }
            let text = "";
            for await (const chunk of reader) {
              if (cancelled) return;
              text += chunk;
              updateCaption(who, id, text, false);
            }
            if (!cancelled) updateCaption(who, id, text, true);
          } catch (e) {
            console.warn("[SimliLK] transcription stream failed:", e);
          }
        });

        // Cards the worker pushes to the screen (#18).
        room.registerTextStreamHandler(TOPIC_SCREEN, async (reader, { identity }) => {
          try {
            const msg = parseScreenMessage(await reader.readAll());
            if (msg && !cancelled) showScreenMessage(msg);
            else if (!msg) console.warn("[SimliLK] ignored screen message from", identity);
          } catch (e) {
            console.warn("[SimliLK] screen stream failed:", e);
          }
        });

        // Her state and language (#24, #25), from whichever remote participant
        // carries them (the worker; the Simli avatar is a separate participant).
        const readAttributes = () => {
          if (cancelled) return;
          let state: string | undefined;
          let language: string | undefined;
          room.remoteParticipants.forEach((p) => {
            state = p.attributes[ATTR_STATE] ?? state;
            language = p.attributes[ATTR_LANGUAGE] ?? language;
          });
          state = devAttrs.current.state ?? state;
          language = devAttrs.current.language ?? language;
          console.log(`[SimliLK] ${ATTR_STATE}=${state ?? "-"} ${ATTR_LANGUAGE}=${language ?? "-"}`);
          setMiaState(asMiaState(state));
          setLang(asLang(language));
        };
        room.on(RoomEvent.ParticipantAttributesChanged, readAttributes);
        room.on(RoomEvent.ParticipantConnected, readAttributes);
        room.on(RoomEvent.ParticipantDisconnected, readAttributes);

        // Whose turn it is, derived from who's actually making sound. The
        // avatar publishes as a remote participant, so anyone remote speaking
        // is her; the local participant is the visitor.
        room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
          if (cancelled) return;
          const visitorTalking = speakers.some((s) => s.isLocal);
          const avatarTalking = speakers.some((s) => !s.isLocal);

          if (avatarTalking) setTurn("answering");
          else if (visitorTalking) setTurn("hearing");
          else {
            // Silence right after the visitor spoke means she's working on a
            // reply; silence otherwise means we're waiting on the visitor.
            setTurn((prev) => (prev === "hearing" ? "thinking" : "waiting"));
          }

          // The first time she goes quiet after speaking, her greeting is
          // done and the mic can open (the mic effect above). She has to have
          // spoken first: before the greeting starts she is quiet too. Wait
          // GREETING_PAUSE_MS so a pause between her sentences doesn't count,
          // restarting the wait whenever she speaks again.
          if (greetedRef.current) return;
          if (avatarTalking) {
            avatarHasSpoken = true;
            clearGreetingQuietTimer();
          } else if (avatarHasSpoken && greetingQuietTimer === null) {
            greetingQuietTimer = window.setTimeout(() => {
              greetingQuietTimer = null;
              if (cancelled) return;
              console.log("[SimliLK] greeting finished");
              setGreetingOver(true);
            }, GREETING_PAUSE_MS);
          }
        });

        await room.connect(url, token);
        if (cancelled) {
          await room.disconnect().catch(() => {});
          return;
        }

        // Start muted so the greeting isn't interrupted by room noise; the
        // mic effect opens it for good once she's done speaking.
        try {
          await room.localParticipant.setMicrophoneEnabled(false);
          console.log("[SimliLK] joined, mic muted for greeting");
        } catch (e) {
          console.warn("[SimliLK] initial mute failed:", e);
        }

        roomRef.current = room;
        readyRef.current = true;
        readAttributes();
        console.log("[SimliLK] in room", room.name);
        tellTop("receptionist-started");
        setStatus("ready");
      } catch (err) {
        console.error("[SimliLK] start error:", err);
        SESSION_ACTIVE = false; // release so a retry/remount can try again
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : "Could not start avatar");
          setStatus("error");
        }
      }
    };

    // Defer one tick so Strict Mode's immediate double-mount cleanup runs before
    // we ever hit the token endpoint — turning a wasteful double-start into a
    // single start on the surviving mount.
    const startTimer = window.setTimeout(start, 0);

    const onUnload = () => {
      try {
        localRoom?.disconnect();
      } catch {}
    };
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);

    return () => {
      cancelled = true;
      readyRef.current = false;
      window.clearTimeout(startTimer);
      clearGreetingQuietTimer();
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
      if (localRoom) {
        localRoom.disconnect().catch(() => {});
      }
      roomRef.current = null;
      SESSION_ACTIVE = false; // release the lock when this session tears down
      // Drop the last frame so the next showing doesn't flash the old session,
      // and wipe the canvas so a resting panel isn't a frozen picture of her
      // (the tour's still image of her shows through instead).
      if (videoRef.current) videoRef.current.srcObject = null;
      const canvas = canvasRef.current;
      canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      clearCaptions();
      setMiaState("listening");
      setListening(false);
      setStatus("idle");
    };
  }, [autoStart, hidden, resting, tellTop, updateCaption, clearCaptions, showScreenMessage]);

  // Dev only (stripped from production builds): drive the screen without a
  // worker, for layout work and the Playwright screenshots. In the browser
  // console of /receptionist-embed:
  //   miaDev.screen({ type: "contact_card" })
  //   miaDev.screen({ type: "message_sent", to: "Nicolas Bastien" })
  //   miaDev.caption("mia", "Bonjour !")      miaDev.caption("visitor", "Hi")
  //   miaDev.state("paused")   miaDev.language("en")   miaDev.end()
  // To go through LiveKit itself, see scripts/mia-screen-push.py.
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    let n = 0;
    const dev = {
      screen: (m: unknown) => {
        const msg = parseScreenMessage(m);
        if (msg) showScreenMessage(msg);
        return msg;
      },
      caption: (who: Speaker, text: string, final = true) => updateCaption(who, `dev-${who}-${n++}`, text, final),
      state: (s: string) => {
        devAttrs.current.state = s;
        setMiaState(asMiaState(s));
      },
      language: (l: string) => {
        devAttrs.current.language = l;
        setLang(asLang(l));
      },
      end: () => roomRef.current?.disconnect(),
    };
    (window as unknown as { miaDev?: typeof dev }).miaDev = dev;
    return () => {
      delete (window as unknown as { miaDev?: typeof dev }).miaDev;
    };
  }, [showScreenMessage, updateCaption]);

  const wake = useCallback(() => {
    setHidden(false);
    setResting(false);
  }, []);

  const connecting = status !== "ready" && status !== "speaking";
  const inSession = !hidden && !resting && !connecting;
  const paused = inSession && miaState === "paused";
  const banner = resting && !hidden ? "resting" : paused ? "paused" : inSession && idleHint ? "idle" : null;
  const showPill = inSession && listening && !banner;
  // Captions stack above whatever holds the bottom edge.
  const captionBottom = banner === "paused" ? "9vw" : banner ? "6vw" : "4.2vw";

  return (
    <div
      // No press-to-talk: if she's on screen, she's hearing you. Visibility is
      // the only thing that gates the mic (see the effect above). The only
      // things to tap are the Contact button, cards and banners.
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "transparent",
        overflow: "hidden",
        fontFamily: "sans-serif",
        color: "white",
        boxSizing: "border-box",
        // Let taps fall through to the panorama behind her instead of dying
        // on this panel; the buttons and cards opt back in.
        pointerEvents: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      {/* Source video. When chroma-keying, it's hidden (feeds the canvas);
          otherwise it's the visible output. It stays muted either way — the
          avatar's TTS audio plays through the <audio> element below. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={
          chromaKey
            ? { position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }
            : {
                width: "100%",
                height: "100%",
                objectFit: "contain",
                transform: `scale(${AVATAR_SCALE})`,
                transformOrigin: "bottom center",
                pointerEvents: "none",
              }
        }
      />

      {/* Chroma-keyed output (backdrop removed). Scaled from the bottom edge:
          objectFit "contain" letterboxes her inside the Web Frame, so there is
          headroom to enlarge her without touching the 3DVista hotspot. Growing
          from "bottom center" keeps her feet planted where they are and pushes
          the extra size upward, rather than sinking her into the floor. */}
      {chromaKey && (
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            transform: `scale(${AVATAR_SCALE})`,
            transformOrigin: "bottom center",
            pointerEvents: "none",
          }}
        />
      )}

      {/* The avatar's TTS audio plays through this element. */}
      <audio ref={audioRef} autoPlay />

      {connecting && !hidden && !resting && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
            color: "rgba(255,255,255,0.95)",
            textShadow: "0 2px 10px rgba(0,0,0,0.9)",
            // No background panel — let the panorama show through while loading.
            background: "transparent",
            textAlign: "center",
            padding: 16,
            pointerEvents: "none",
          }}
        >
          {status === "error" ? errorMsg ?? "Something went wrong" : "Connecting..."}
        </div>
      )}

      {/* Turn indicator, resting on the bottom edge of the frame. Kept a full
          rounded pill: squaring the bottom corners to sit flush made it read
          as clipped rather than deliberate. Shown only while the mic is
          genuinely open, so it never promises she's listening when she isn't.

          Every state is stacked in one grid cell, with the inactive ones kept
          in the layout but invisible. That sizes the pill to the *longest*
          label ("Go ahead — I'm listening") permanently, so it doesn't resize
          as the state changes — and it stays correct if the wording changes,
          unlike a hardcoded width.

          While she's paused or nobody has spoken for a while, a banner takes
          its place (below). Sized in vw like the rest of the overlay: the
          frame is 1280px wide but drawn ~0.7x on the kiosk, so 13px was ~9px. */}
      {showPill && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: 0,
            transform: "translateX(-50%)",
            display: "grid",
            padding: "0.7vw 1.4vw",
            lineHeight: 1.25,
            borderRadius: 999,
            background: TURN_LABEL[turn].bg,
            color: "white",
            fontSize: "clamp(13px, 1.45vw, 24px)",
            fontWeight: 600,
            textAlign: "center",
            textShadow: "0 2px 8px rgba(0,0,0,0.8)",
            pointerEvents: "none",
            whiteSpace: "nowrap",
            transition: "background 0.2s ease",
          }}
        >
          {TURNS.map((t) => (
            <span
              key={t}
              style={{
                gridArea: "1 / 1",
                visibility: t === turn ? "visible" : "hidden",
              }}
            >
              {TURN_LABEL[t].text}
            </span>
          ))}
        </div>
      )}

      {!hidden && (
        <MiaCaptions
          captions={captions}
          lang={lang}
          // While paused she isn't in the conversation: the visitor is talking
          // to someone else, which has no business on the screen.
          showVisitor={!paused}
          bottom={captionBottom}
        />
      )}

      {banner && (
        <MiaBanner
          kind={banner}
          lang={lang}
          onTap={() => {
            if (banner === "resting") wake();
            else {
              // Paused: ask the worker to resume. Idle: tell it someone is
              // there; either way the mic is already open.
              sendControl({ type: banner === "paused" ? "resume" : "wake" });
              setIdleTick((t) => t + 1);
            }
          }}
        />
      )}

      {!hidden && (
        <ContactButton
          active={card?.type === "contact_card"}
          onClick={() =>
            card?.type === "contact_card" ? setCard(null) : showScreenMessage({ type: "contact_card" })
          }
        />
      )}

      {!hidden && card && <MiaScreenCard card={card} onClose={() => setCard(null)} />}
    </div>
  );
}
