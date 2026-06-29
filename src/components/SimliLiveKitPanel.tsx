"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";

// Simli Trinity receptionist over LiveKit. Unlike SimliReceptionistPanel (which
// used Simli Auto + Daily, a Legacy-only pipeline), this joins a LiveKit room
// where a self-hosted worker (agent-worker/) renders the Trinity face.
//
// Behaviour mirrors the Daily panel:
//   - On load: get a token from /api/livekit/token, join the room, show the
//     avatar, and let the worker speak its first message on its own. Mic starts
//     MUTED so she greets without listening.
//   - Push-to-talk: press & hold the frame -> mic on; release -> mic off -> she
//     answers. The avatar is always visible.

type Status = "idle" | "connecting" | "ready" | "speaking" | "error";

type Props = {
  autoStart?: boolean;
  // Chroma-key the avatar's pink studio background to transparent so she stands
  // directly in the panorama. On by default; pass chromaKey={false} to show the
  // raw video (pink square).
  chromaKey?: boolean;
};

// Chroma-key the green-screen backdrop (Simli face 4957476d renders on green).
// Pure green keys to fully transparent; greens near it taper off so edges are
// soft (kills hair fringing). Despill nudges remaining edge greens to neutral.
// Same tuning the HeyGen ImmersiveReceptionistPanel uses.
const KEY_HUE_LOW = 80; // hue wheel degrees — pure green is 120
const KEY_HUE_HIGH = 160;
const SAT_THRESHOLD = 0.25; // above this -> fully transparent
const EDGE_SAT_LOW = 0.1; // ramp alpha between this and SAT_THRESHOLD
const VAL_THRESHOLD = 0.2; // ignore very dark pixels (hair shadows)

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

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

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const roomRef = useRef<Room | null>(null);
  const readyRef = useRef(false); // true once joined, so PTT can toggle the mic

  // Push-to-talk: enable the mic only while held.
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

  // Chroma-key paint loop: draw the avatar video to a canvas every frame and
  // knock out the pink studio backdrop so she stands directly in the panorama.
  // Mirrors the green-screen approach in ImmersiveReceptionistPanel, retuned for
  // pink. Skipped entirely when chromaKey is false (video shown directly).
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
        const data = frame.data;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i],
            g = data[i + 1],
            b = data[i + 2];
          // Quick reject: not green-dominant -> keep opaque.
          if (g <= r || g <= b) continue;

          const [h, s, v] = rgbToHsv(r, g, b);
          if (v < VAL_THRESHOLD) continue;
          if (h < KEY_HUE_LOW || h > KEY_HUE_HIGH) continue;

          if (s >= SAT_THRESHOLD) {
            data[i + 3] = 0;
          } else if (s >= EDGE_SAT_LOW) {
            // Edge: ramp alpha for a soft cutoff.
            const t = (s - EDGE_SAT_LOW) / (SAT_THRESHOLD - EDGE_SAT_LOW);
            data[i + 3] = Math.round(255 * (1 - t));
            // Despill: pull green down toward the avg of red+blue so remaining
            // edge pixels don't look fluorescent.
            const avgRB = (r + b) / 2;
            if (g > avgRB) data[i + 1] = Math.round(avgRB + (g - avgRB) * 0.4);
          }
        }

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

  useEffect(() => {
    if (!autoStart) return;

    let cancelled = false;
    let localRoom: Room | null = null;

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

        room.on(RoomEvent.Disconnected, () => {
          if (cancelled) return;
          console.warn("[SimliLK] room disconnected");
        });

        await room.connect(url, token);
        if (cancelled) {
          await room.disconnect().catch(() => {});
          return;
        }

        // Mute the mic immediately so the avatar speaks its first message
        // without listening. Push-to-talk turns it on only while held.
        try {
          await room.localParticipant.setMicrophoneEnabled(false);
          console.log("[SimliLK] joined, mic muted");
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
            : { width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" }
        }
      />

      {/* Chroma-keyed output (pink backdrop removed). */}
      {chromaKey && (
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            pointerEvents: "none",
          }}
        />
      )}

      {/* The avatar's TTS audio plays through this element. */}
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
