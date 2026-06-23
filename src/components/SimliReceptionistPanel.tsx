"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Simli Auto (E2E) receptionist. Uses Simli + Haiku instead of LiveAvatar.
//
// Behaviour:
//   - On load: connect, show the avatar, and let Simli speak its First Message
//     on its own. The mic starts MUTED so she greets without listening.
//   - Push-to-talk: press & hold the frame -> mic on (listening); release ->
//     mic off -> Simli answers. The avatar is always visible.
//
// Flow: POST /api/simli/session starts a Simli Auto session (Haiku LLM via
// Anthropic's OpenAI-compat endpoint, Simli's bundled TTS, firstMessage +
// systemPrompt set server-side) and returns a Daily.co { roomUrl }. We join the
// room, attach the avatar's video+audio, and toggle the local mic for PTT.

type Status = "idle" | "connecting" | "ready" | "speaking" | "error";

type Props = {
  autoStart?: boolean;
};

// Minimal shape of the Daily call object we use.
type DailyCallLike = {
  join: (opts: { url: string }) => Promise<unknown>;
  leave: () => Promise<void>;
  destroy: () => Promise<void>;
  setLocalAudio: (enabled: boolean) => unknown;
  localAudio: () => boolean;
  on: (event: string, cb: (e: unknown) => void) => unknown;
};

// Module-level lock. React Strict Mode (dev) mounts effects twice, and each
// session start hits Simli's rate-limited endpoint. This ensures only ONE
// session is ever starting/alive across remounts — the single biggest cause of
// the 429s we hit while testing.
let SESSION_ACTIVE = false;

export default function SimliReceptionistPanel({ autoStart = true }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [listening, setListening] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const callRef = useRef<DailyCallLike | null>(null);
  const readyRef = useRef(false); // true once joined, so PTT can toggle the mic

  // Push-to-talk: enable the mic only while held.
  const setMic = useCallback((on: boolean) => {
    const call = callRef.current;
    if (!call || !readyRef.current) return;
    try {
      call.setLocalAudio(on);
      setListening(on);
      // Daily applies the change asynchronously — read the real state after a
      // tick so the log isn't lying about the previous value.
      setTimeout(() => {
        console.log("[Simli] mic set ->", on, "| actual now:", call.localAudio?.());
      }, 250);
    } catch (e) {
      console.warn("[Simli] setLocalAudio failed:", e);
    }
  }, []);

  useEffect(() => {
    if (!autoStart) return;

    let cancelled = false;
    let localCall: DailyCallLike | null = null;

    const attachTrack = (el: HTMLMediaElement | null, track: MediaStreamTrack) => {
      if (!el) return;
      el.srcObject = new MediaStream([track]);
      el.play().catch((e) => console.warn("[Simli] media play() blocked:", e));
    };

    const start = async () => {
      // Don't start a second session if one is already alive (Strict Mode
      // double-mount, fast remount). This is the main 429 guard.
      if (SESSION_ACTIVE) {
        console.log("[Simli] session already active, skipping duplicate start");
        return;
      }
      SESSION_ACTIVE = true;
      setStatus("connecting");
      setErrorMsg(null);
      try {
        const res = await fetch("/api/simli/session", { method: "POST" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error || `Session request failed: ${res.status}`);
        }
        const { roomUrl } = await res.json();
        if (cancelled) return;
        if (!roomUrl) throw new Error("No roomUrl returned");
        console.log("[Simli] joining room:", roomUrl);

        const DailyIframe = (await import("@daily-co/daily-js")).default;
        if (cancelled) return;

        const call = DailyIframe.createCallObject({
          audioSource: true,
          videoSource: false,
        }) as unknown as DailyCallLike;
        localCall = call;

        call.on("track-started", (e: unknown) => {
          if (cancelled) return;
          const evt = e as {
            track?: MediaStreamTrack;
            participant?: { local?: boolean } | null;
          };
          console.log("[Simli] track-started:", {
            kind: evt.track?.kind,
            local: evt.participant?.local,
          });
          if (!evt.track || evt.participant?.local) return;
          if (evt.track.kind === "video") {
            attachTrack(videoRef.current, evt.track);
            setStatus("ready");
          } else if (evt.track.kind === "audio") {
            attachTrack(audioRef.current, evt.track);
          }
        });

        call.on("error", (e: unknown) => {
          if (cancelled) return;
          console.error("[Simli] daily error:", e);
          setErrorMsg((e as { errorMsg?: string })?.errorMsg || "Call error");
          setStatus("error");
        });

        await call.join({ url: roomUrl });
        if (cancelled) {
          await call.leave().catch(() => {});
          await call.destroy().catch(() => {});
          return;
        }

        // Mute the mic immediately so the avatar speaks its First Message
        // without listening. Push-to-talk turns it on only while held.
        try {
          call.setLocalAudio(false);
          console.log("[Simli] joined, mic muted. localAudio:", call.localAudio?.());
        } catch (e) {
          console.warn("[Simli] initial mute failed:", e);
        }

        callRef.current = call;
        readyRef.current = true;
        setStatus("ready");
      } catch (err) {
        console.error("[Simli] start error:", err);
        SESSION_ACTIVE = false; // release so a retry/remount can try again
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : "Could not start avatar");
          setStatus("error");
        }
      }
    };

    // Defer one tick so Strict Mode's immediate double-mount cleanup runs before
    // we ever hit the session endpoint — turning a wasteful double-start into a
    // single start on the surviving mount.
    const startTimer = window.setTimeout(start, 0);

    const onUnload = () => {
      try {
        localCall?.leave();
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
      if (localCall) {
        localCall.leave().catch(() => {});
        localCall.destroy().catch(() => {});
      }
      SESSION_ACTIVE = false; // release the lock when this session tears down
    };
  }, [autoStart]);

  const connecting = status !== "ready" && status !== "speaking";

  return (
    <div
      // Push-to-talk: hold to listen, release to send.
      onPointerDown={(e) => {
        e.preventDefault();
        setMic(true);
      }}
      onPointerUp={(e) => {
        e.preventDefault();
        setMic(false);
      }}
      onPointerLeave={() => {
        if (listening) setMic(false);
      }}
      onPointerCancel={() => {
        if (listening) setMic(false);
      }}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "transparent",
        overflow: "hidden",
        fontFamily: "sans-serif",
        color: "white",
        boxSizing: "border-box",
        cursor: status === "ready" ? "pointer" : "default",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{ width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" }}
      />
      {/* Simli's TTS audio plays through this element. */}
      <audio ref={audioRef} autoPlay />

      {connecting && (
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

      {/* Push-to-talk hint / listening indicator. */}
      {!connecting && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: 22,
            transform: "translateX(-50%)",
            padding: "8px 16px",
            borderRadius: 999,
            background: listening ? "rgba(239,68,68,0.9)" : "rgba(0,0,0,0.5)",
            color: "white",
            fontSize: 13,
            fontWeight: 600,
            textShadow: "0 2px 8px rgba(0,0,0,0.8)",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {listening ? "● Listening…" : "🎙️ Hold to talk"}
        </div>
      )}
    </div>
  );
}
