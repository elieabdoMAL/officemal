"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Simli Auto (E2E) receptionist. Drop-in alternative to ReceptionistPanel that
// uses Simli + Haiku instead of LiveAvatar FULL mode.
//
// Flow:
//   1. POST /api/simli/session -> server starts a Simli Auto session (Haiku as
//      the LLM via Anthropic's OpenAI-compat endpoint, Simli's bundled TTS) and
//      returns a Daily.co room { roomUrl }. (Simli runs its Auto sessions on
//      Daily, not LiveKit — confirmed from a live response.)
//   2. We join the Daily room. Daily auto-captures the user's mic; we attach
//      the avatar's remote video+audio tracks to <video>/<audio>. Simli runs
//      the whole STT -> LLM -> TTS loop, so there is no typing path — the user
//      just talks.

type Status = "idle" | "connecting" | "ready" | "speaking" | "error";

type Props = {
  // Start immediately on mount vs. show a "Start" button first. Browsers block
  // mic capture in nested iframes without a user gesture, so the button is the
  // safer default for the 3DVista Web Frame embed.
  autoStart?: boolean;
};

// Minimal shape of the Daily call object we use (avoids importing SDK types at
// module scope; the SDK is dynamically imported to keep it out of the bundle).
type DailyCallLike = {
  join: (opts: { url: string }) => Promise<unknown>;
  leave: () => Promise<void>;
  destroy: () => Promise<void>;
  on: (event: string, cb: (e: unknown) => void) => unknown;
};

export default function SimliReceptionistPanel({ autoStart = false }: Props) {
  const [active, setActive] = useState(autoStart);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const callRef = useRef<DailyCallLike | null>(null);

  const teardown = useCallback(async () => {
    try {
      await callRef.current?.leave();
    } catch {}
    try {
      await callRef.current?.destroy();
    } catch {}
    callRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    setStatus("idle");
  }, []);

  useEffect(() => {
    if (!active) {
      teardown();
      return;
    }

    let cancelled = false;
    let localCall: DailyCallLike | null = null;

    // Attach a remote track to its element via a one-track MediaStream — the
    // portable way to render a raw MediaStreamTrack from Daily.
    const attachTrack = (el: HTMLMediaElement | null, track: MediaStreamTrack) => {
      if (!el) return;
      el.srcObject = new MediaStream([track]);
      el.play().catch(() => {});
    };

    const start = async () => {
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

        const DailyIframe = (await import("@daily-co/daily-js")).default;
        if (cancelled) return;

        // Mic on (so Simli's STT hears the user), camera off (we only render the
        // avatar, the user isn't on screen).
        const call = DailyIframe.createCallObject({
          audioSource: true,
          videoSource: false,
        }) as unknown as DailyCallLike;
        localCall = call;

        // Avatar tracks arrive as 'track-started'. participant.local === false
        // means it's a remote (the avatar) track, not our own mic echo.
        call.on("track-started", (e: unknown) => {
          if (cancelled) return;
          const evt = e as {
            track?: MediaStreamTrack;
            type?: string;
            participant?: { local?: boolean } | null;
          };
          if (!evt.track || evt.participant?.local) return;
          if (evt.type === "video") {
            attachTrack(videoRef.current, evt.track);
          } else if (evt.type === "audio") {
            attachTrack(audioRef.current, evt.track);
            setStatus("speaking");
          }
        });

        // Remote audio stopping is our cue the avatar finished a turn.
        call.on("track-stopped", (e: unknown) => {
          if (cancelled) return;
          const evt = e as { type?: string; participant?: { local?: boolean } | null };
          if (evt.participant?.local) return;
          if (evt.type === "audio") setStatus("ready");
        });

        call.on("left-meeting", () => {
          if (cancelled) return;
          setStatus("idle");
        });

        call.on("error", (e: unknown) => {
          if (cancelled) return;
          const msg = (e as { errorMsg?: string })?.errorMsg || "Call error";
          console.error("[SimliReceptionist] daily error:", e);
          setErrorMsg(msg);
          setStatus("error");
        });

        await call.join({ url: roomUrl });
        if (cancelled) {
          await call.leave().catch(() => {});
          await call.destroy().catch(() => {});
          return;
        }

        callRef.current = call;
        setStatus("ready");
      } catch (err) {
        console.error("[SimliReceptionist] start error:", err);
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : "Could not start avatar");
          setStatus("error");
        }
      }
    };

    start();

    // A tab close leaves the Simli session billing until its idle timeout —
    // leave synchronously to release it (and the concurrency slot).
    const onUnload = () => {
      try {
        localCall?.leave();
      } catch {}
    };
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);

    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
      if (localCall) {
        localCall.leave().catch(() => {});
        localCall.destroy().catch(() => {});
      }
    };
  }, [active, teardown]);

  if (!active) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(0,0,0,0.35)",
          backdropFilter: "blur(8px)",
          fontFamily: "sans-serif",
          color: "white",
        }}
      >
        <button
          onClick={() => setActive(true)}
          style={{
            padding: "14px 22px",
            background: "rgba(0,112,243,0.9)",
            border: "none",
            borderRadius: 999,
            color: "white",
            fontSize: 16,
            fontWeight: 600,
            cursor: "pointer",
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          }}
        >
          🎙️ Talk to receptionist
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "rgba(0, 0, 0, 0.45)",
        backdropFilter: "blur(20px)",
        border: "1px solid rgba(255,255,255,0.2)",
        borderRadius: 20,
        boxShadow: "0 25px 50px rgba(0,0,0,0.4)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontFamily: "sans-serif",
        color: "white",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          flex: 1,
          background: "rgba(0,0,0,0.4)",
          overflow: "hidden",
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
        {/* Simli's TTS audio plays through this element. */}
        <audio ref={audioRef} autoPlay />
        {status !== "ready" && status !== "speaking" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 13,
              color: "rgba(255,255,255,0.85)",
              background: "rgba(0,0,0,0.5)",
              textAlign: "center",
              padding: 12,
            }}
          >
            {status === "connecting" && "Connecting…"}
            {status === "error" && (errorMsg ?? "Something went wrong")}
            {status === "idle" && "Starting…"}
          </div>
        )}
      </div>

      <div
        style={{
          padding: "10px 14px",
          borderTop: "1px solid rgba(255,255,255,0.15)",
          fontSize: 13,
          textAlign: "center",
          color: "rgba(255,255,255,0.75)",
          flexShrink: 0,
        }}
      >
        {status === "speaking"
          ? "Speaking…"
          : status === "ready"
          ? "Listening — just talk."
          : " "}
      </div>
    </div>
  );
}
