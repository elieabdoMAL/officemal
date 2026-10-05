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

// Simli Trinity receptionist over LiveKit. Unlike SimliReceptionistPanel (which
// used Simli Auto + Daily, a Legacy-only pipeline), this joins a LiveKit room
// where a self-hosted worker (agent-worker/) renders the Trinity face.
//
// Behaviour mirrors the Daily panel:
//   - On load: get a token from /api/livekit/token, join the room, show the
//     avatar, and let the worker speak its first message on its own. Mic starts
//     MUTED so she greets without listening.
//   - Then the mic opens and STAYS open: she listens continuously and the
//     worker's VAD decides when a turn ends. When the transcript is too weak to
//     act on, the worker answers "I'm sorry, I didn't get that."
//   - A session lives only while she's shown. Hiding the frame (AI button, a
//     3DVista action) leaves the room, which ends the session server-side;
//     showing it again starts a fresh one, greeting and all. Hiding a Web Frame
//     doesn't unload it, so this is done by hand rather than by unmounting.
//   - The worker ends sessions on its own (2 min idle / 10 min max) by deleting
//     the room. When that happens we tell the top page, whose AI button hides
//     the frame, so the next visitor brings her back with one tap.

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

// How long to keep the mic shut after joining so her own greeting doesn't land
// in her ears. FIRST_MESSAGE is one short sentence; ~6s covers it.
const GREETING_MS = 6000;

// Longest we'll claim she's "thinking" before admitting we're back to waiting.
const THINKING_TIMEOUT_MS = 8000;

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
  const [turn, setTurn] = useState<Turn>("waiting");

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
  // turn ends). The only delay is GREETING_MS on the very first open, so her
  // own greeting doesn't land in her ears — coming back from hidden is
  // instant, since she's already said it. Browser echo cancellation covers the
  // rest of the session.
  const greetedRef = useRef(false);
  useEffect(() => {
    if (status !== "ready" || hidden) return;

    if (greetedRef.current) {
      setMic(true);
      return;
    }
    const timer = window.setTimeout(() => {
      greetedRef.current = true;
      setMic(true);
    }, GREETING_MS);
    return () => window.clearTimeout(timer);
  }, [status, hidden, setMic]);

  // The panorama can hide this Web Frame (AiToggle button / a 3DVista action).
  // Hiding doesn't unload the iframe, so `hidden` is what ends the session (see
  // the connection effect) and starts a new one when she's shown again.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; visible?: boolean; muted?: boolean };
      if (data?.type === "receptionist-visible" && typeof data.visible === "boolean") {
        setHidden(!data.visible);
      } else if (data?.type === "receptionist-mute" && typeof data.muted === "boolean") {
        setHidden(data.muted);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

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
    if (!autoStart || hidden) return;

    let cancelled = false;
    let localRoom: Room | null = null;
    // Each session opens with her greeting, so the mic waits for it again.
    greetedRef.current = false;
    setTurn("waiting");

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
        // gone, so stand down and ask the top page to switch the AI button off.
        room.on(RoomEvent.Disconnected, (reason) => {
          if (cancelled) return;
          console.warn("[SimliLK] room ended:", reason);
          try {
            window.top?.postMessage({ type: "receptionist-ended" }, window.location.origin);
          } catch {}
          setHidden(true);
        });

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
        });

        await room.connect(url, token);
        if (cancelled) {
          await room.disconnect().catch(() => {});
          return;
        }

        // Start muted so the greeting isn't interrupted by room noise; the
        // effect below opens the mic for good once she's done speaking.
        try {
          await room.localParticipant.setMicrophoneEnabled(false);
          console.log("[SimliLK] joined, mic muted for greeting");
        } catch (e) {
          console.warn("[SimliLK] initial mute failed:", e);
        }

        roomRef.current = room;
        readyRef.current = true;
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
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
      if (localRoom) {
        localRoom.disconnect().catch(() => {});
      }
      roomRef.current = null;
      SESSION_ACTIVE = false; // release the lock when this session tears down
      // Drop the last frame so the next showing doesn't flash the old session.
      if (videoRef.current) videoRef.current.srcObject = null;
      setListening(false);
      setStatus("idle");
    };
  }, [autoStart, hidden]);

  const connecting = status !== "ready" && status !== "speaking";

  return (
    <div
      // No press-to-talk: if she's on screen, she's hearing you. Visibility is
      // the only thing that gates the mic (see the effect above), so there's
      // nothing to click here.
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "transparent",
        overflow: "hidden",
        fontFamily: "sans-serif",
        color: "white",
        boxSizing: "border-box",
        // Nothing here is interactive any more — let taps fall through to the
        // panorama behind her instead of dying on this panel.
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

      {connecting && !hidden && (
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
          unlike a hardcoded width. */}
      {!connecting && !hidden && listening && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: 0,
            transform: "translateX(-50%)",
            display: "grid",
            padding: "9px 18px",
            lineHeight: 1.25,
            borderRadius: 999,
            background: TURN_LABEL[turn].bg,
            color: "white",
            fontSize: 13,
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
    </div>
  );
}
