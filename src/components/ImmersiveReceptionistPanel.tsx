"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Immersive variant of the receptionist designed for a 3DVista Web Frame hotspot.
// Differences from ReceptionistPanel:
//   1. Chroma-keys the green-screen avatar in real time via canvas -> no background.
//   2. Tap-anywhere-to-talk: hold the frame to record, release to send. No chat UI.
//   3. Auto-starts; assumes the user gesture happened when they entered the panorama.

type SpeechRecognitionResult = {
  isFinal: boolean;
  0: { transcript: string };
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResult>;
};
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

type Status = "idle" | "connecting" | "ready" | "thinking" | "speaking" | "error";

type LiveAvatarSessionInstance = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  attach: (el: HTMLMediaElement) => void;
  message: (text: string) => string;
  on: (event: string, cb: (...args: unknown[]) => void) => unknown;
};

// Chroma-key tuning for the LiveAvatar green-screen backdrop. Pure green keys
// to fully transparent; greens close to it taper off so edges are soft, which
// kills hair fringing. Despill nudges remaining edge greens toward neutral.
const KEY_HUE_LOW = 80;   // hue wheel degrees — pure green is 120
const KEY_HUE_HIGH = 160;
const SAT_THRESHOLD = 0.25; // above this -> fully transparent
const EDGE_SAT_LOW = 0.10;  // ramp alpha between this and SAT_THRESHOLD
const VAL_THRESHOLD = 0.20; // ignore very dark pixels (hair shadows)

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
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

export default function ImmersiveReceptionistPanel() {
  const [status, setStatus] = useState<Status>("connecting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sessionRef = useRef<LiveAvatarSessionInstance | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const rafRef = useRef<number | null>(null);

  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!sessionRef.current) return;
    setStatus("thinking");
    try {
      sessionRef.current.message(trimmed);
    } catch (err) {
      console.error("[Immersive] message error:", err);
      setErrorMsg(err instanceof Error ? err.message : "Message error");
      setStatus("error");
    }
  }, []);

  // Paint loop: chroma-key the avatar video onto the canvas every frame.
  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    const paint = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
        if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = frame.data;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
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
            // Despill: pull green down toward the avg of red+blue so the
            // remaining edge pixels don't look fluorescent.
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
  }, []);

  // Start session on mount; teardown on unmount.
  // In React Strict Mode (dev) effects double-fire, which would race two
  // concurrent HeyGen sessions against each other. Delay the start by one
  // microtask so the first mount's cleanup wins before the second mount
  // creates its own session — preventing the unmounted mount-1 cleanup from
  // killing mount-2's still-alive session.
  useEffect(() => {
    let cancelled = false;
    let localSession: LiveAvatarSessionInstance | null = null;

    const start = async () => {
      setStatus("connecting");
      setErrorMsg(null);
      try {
        const tokenRes = await fetch("/api/heygen/token", { method: "POST" });
        if (!tokenRes.ok) throw new Error(`Token request failed: ${tokenRes.status}`);
        const { token } = await tokenRes.json();
        if (cancelled) return;

        const mod = await import("@heygen/liveavatar-web-sdk");
        if (cancelled) return;

        const session = new mod.LiveAvatarSession(token, {
          voiceChat: false,
        }) as unknown as LiveAvatarSessionInstance;
        localSession = session;

        session.on(mod.SessionEvent.SESSION_STREAM_READY, () => {
          if (cancelled) return;
          if (videoRef.current) {
            session.attach(videoRef.current);
            videoRef.current.play().catch(() => {});
          }
          setStatus("ready");
        });

        session.on(mod.SessionEvent.SESSION_DISCONNECTED, () => {
          if (cancelled) return;
          setStatus("idle");
        });

        session.on(mod.AgentEventsEnum.AVATAR_TRANSCRIPTION_CHUNK, () => {
          if (cancelled) return;
          setStatus("speaking");
        });

        session.on(mod.AgentEventsEnum.AVATAR_TRANSCRIPTION, () => {
          if (cancelled) return;
          setStatus("ready");
        });

        await session.start();
        if (cancelled) {
          await session.stop().catch(() => {});
          return;
        }
        sessionRef.current = session;
      } catch (err) {
        console.error("[Immersive] start error:", err);
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : "Could not start avatar");
          setStatus("error");
        }
      }
    };

    // Defer one tick so Strict Mode's immediate double-fire's cleanup runs
    // before we even hit the token endpoint — turning the wasteful double-
    // start into a single start on the surviving mount.
    const startTimer = window.setTimeout(start, 0);

    const onUnload = () => {
      try {
        localSession?.stop();
      } catch {}
    };
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);

    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
      try {
        recognitionRef.current?.abort();
      } catch {}
      recognitionRef.current = null;
      if (localSession) {
        localSession.stop().catch(() => {});
      }
    };
  }, []);

  // Tap-to-talk: hold the frame down to listen, release to send.
  const startListening = () => {
    if (recognitionRef.current) return;
    if (status === "connecting" || status === "error") return;
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      setErrorMsg("Voice input not supported in this browser.");
      return;
    }
    const recognition = new Ctor();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (e) => {
      let transcript = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript;
      }
      if (transcript) sendMessage(transcript);
    };
    recognition.onerror = () => {
      setIsListening(false);
    };
    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };
    try {
      recognition.start();
      recognitionRef.current = recognition;
      setIsListening(true);
    } catch (err) {
      console.error("[Immersive] speech start error:", err);
    }
  };

  const stopListening = () => {
    try {
      recognitionRef.current?.stop();
    } catch {}
  };

  return (
    <div
      onPointerDown={(e) => {
        e.preventDefault();
        startListening();
      }}
      onPointerUp={(e) => {
        e.preventDefault();
        stopListening();
      }}
      onPointerLeave={() => {
        if (isListening) stopListening();
      }}
      onPointerCancel={() => {
        if (isListening) stopListening();
      }}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "transparent",
        cursor: status === "ready" || status === "speaking" ? "pointer" : "default",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        overflow: "hidden",
      }}
    >
      {/* Source video, hidden — feeds the canvas. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={false}
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "none",
        }}
      />

      {/* Chroma-keyed output. */}
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

      {/* Status overlays — tiny, fade with status. */}
      {status === "connecting" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(255,255,255,0.85)",
            fontFamily: "sans-serif",
            fontSize: 13,
            textShadow: "0 2px 8px rgba(0,0,0,0.8)",
            pointerEvents: "none",
          }}
        >
          Connecting…
        </div>
      )}

      {status === "error" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(255,200,200,0.95)",
            fontFamily: "sans-serif",
            fontSize: 13,
            textShadow: "0 2px 8px rgba(0,0,0,0.8)",
            padding: 20,
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          {errorMsg ?? "Something went wrong"}
        </div>
      )}

      {/* Listening ring — subtle pulse around the bottom of the frame. */}
      {isListening && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: 24,
            transform: "translateX(-50%)",
            padding: "6px 14px",
            borderRadius: 999,
            background: "rgba(239,68,68,0.85)",
            color: "white",
            fontSize: 12,
            fontFamily: "sans-serif",
            fontWeight: 600,
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            pointerEvents: "none",
          }}
        >
          ● Listening…
        </div>
      )}
    </div>
  );
}
