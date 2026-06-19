"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Simli Auto (E2E) receptionist. Drop-in alternative to ReceptionistPanel that
// uses Simli + Haiku instead of LiveAvatar FULL mode.
//
// Flow:
//   1. POST /api/simli/session -> server starts a Simli Auto session (Haiku as
//      the LLM via Anthropic's OpenAI-compat endpoint, Simli's bundled TTS) and
//      returns a LiveKit { roomUrl }.
//   2. We join the LiveKit room, attach the avatar's remote video+audio, and
//      publish the user's mic. Simli runs the whole STT -> LLM -> TTS loop, so
//      there is no message()/typing path — the user just talks.

type Status = "idle" | "connecting" | "ready" | "speaking" | "error";

type Props = {
  // Start immediately on mount vs. show a "Start" button first. Browsers block
  // mic capture in nested iframes without a user gesture, so the button is the
  // safer default for the 3DVista Web Frame embed.
  autoStart?: boolean;
};

// Simli returns one roomUrl that embeds the LiveKit join token as a query param.
// livekit-client's Room.connect() wants the base URL and token separately, so
// split them. Token param name isn't formally documented; accept the common
// ones. Returns [baseUrl, token | undefined].
function splitRoomUrl(roomUrl: string): [string, string | undefined] {
  try {
    const u = new URL(roomUrl);
    const token =
      u.searchParams.get("access_token") ??
      u.searchParams.get("token") ??
      u.searchParams.get("jwt") ??
      undefined;
    // Strip the query so the base wss:// URL is clean for connect().
    u.search = "";
    return [u.toString(), token ?? undefined];
  } catch {
    // Not a parseable URL — hand it back whole and let connect() try.
    return [roomUrl, undefined];
  }
}

export default function SimliReceptionistPanel({ autoStart = false }: Props) {
  const [active, setActive] = useState(autoStart);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // LiveKit Room instance — typed loosely so we don't import the SDK types at
  // module scope (the SDK is dynamically imported to keep it out of the main
  // bundle, matching how the LiveAvatar SDK was loaded).
  const roomRef = useRef<{ disconnect: (stopTracks?: boolean) => Promise<void> } | null>(null);

  const teardown = useCallback(async () => {
    try {
      await roomRef.current?.disconnect();
    } catch {}
    roomRef.current = null;
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
    let localRoom: { disconnect: (stopTracks?: boolean) => Promise<void> } | null = null;

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

        const { Room, RoomEvent, Track } = await import("livekit-client");
        if (cancelled) return;

        const room = new Room();
        localRoom = room;

        // Attach the avatar's tracks as they arrive. Simli publishes one video
        // (the talking head) and one audio (the TTS voice) track.
        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (cancelled) return;
          if (track.kind === Track.Kind.Video && videoRef.current) {
            track.attach(videoRef.current);
            videoRef.current.play().catch(() => {});
          } else if (track.kind === Track.Kind.Audio && audioRef.current) {
            track.attach(audioRef.current);
            audioRef.current.play().catch(() => {});
          }
        });

        // Avatar starts/stops talking -> drive the status label.
        room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          if (cancelled) return;
          // Any remote (non-local) speaker means the avatar is talking.
          const avatarTalking = speakers.some((p) => !p.isLocal);
          setStatus(avatarTalking ? "speaking" : "ready");
        });

        room.on(RoomEvent.Disconnected, () => {
          if (cancelled) return;
          setStatus("idle");
        });

        const [url, token] = splitRoomUrl(roomUrl);
        if (!token) {
          // If the token wasn't a recognized query param, connect() will reject
          // and we surface a clear message rather than a cryptic LiveKit error.
          throw new Error(
            "Could not extract LiveKit token from Simli roomUrl — check the param name."
          );
        }
        await room.connect(url, token);
        if (cancelled) {
          await room.disconnect().catch(() => {});
          return;
        }

        // Publish the mic so Simli can hear the user. Simli does STT server-side.
        await room.localParticipant.setMicrophoneEnabled(true);

        roomRef.current = room;
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
    // disconnect synchronously to release it (and the concurrency slot).
    const onUnload = () => {
      try {
        localRoom?.disconnect();
      } catch {}
    };
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);

    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
      if (localRoom) localRoom.disconnect().catch(() => {});
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
