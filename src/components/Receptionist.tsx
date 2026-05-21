"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Minimal SpeechRecognition typings (not in TS lib by default).
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

const TRIGGER_ID = "receptionist";
const IDLE_TIMEOUT_MS = 60_000;

type ChatMessage = { role: "user" | "assistant"; content: string };
type Status = "idle" | "connecting" | "ready" | "thinking" | "error";

type LiveAvatarSessionInstance = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  attach: (el: HTMLMediaElement) => void;
  // In FULL mode the avatar's own LLM generates the reply. We just feed the
  // user's input via message(); the avatar emits AVATAR_TRANSCRIPTION events
  // with the response text as it speaks it.
  message: (text: string) => string;
  on: (event: string, cb: (...args: unknown[]) => void) => unknown;
};

export default function Receptionist() {
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typed, setTyped] = useState("");
  const [isRecording, setIsRecording] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<LiveAvatarSessionInstance | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  // Track whether the in-progress assistant bubble is still being filled by
  // streaming AVATAR_TRANSCRIPTION_CHUNK events so we can append vs create.
  const assistantStreamingRef = useRef(false);

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => {
      setIsOpen(false);
    }, IDLE_TIMEOUT_MS);
  }, []);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const allowed = e.origin === window.location.origin || e.origin === "null";
      if (!allowed) return;
      const { type, triggerId } = e.data || {};
      if (type === "hotspot-trigger" && triggerId === TRIGGER_ID) {
        setIsOpen(true);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const teardown = useCallback(async () => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    try {
      recognitionRef.current?.abort();
    } catch {}
    recognitionRef.current = null;
    try {
      await sessionRef.current?.stop();
    } catch {}
    sessionRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setStatus("idle");
    setIsRecording(false);
    setMessages([]);
    assistantStreamingRef.current = false;
  }, []);

  useEffect(() => {
    if (!isOpen) {
      teardown();
      return;
    }

    let cancelled = false;

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

        session.on(mod.SessionEvent.SESSION_STREAM_READY, () => {
          if (cancelled) return;
          if (videoRef.current) {
            session.attach(videoRef.current);
            videoRef.current.play().catch(() => {});
          }
          setStatus("ready");
          resetIdleTimer();
        });

        session.on(mod.SessionEvent.SESSION_DISCONNECTED, () => {
          if (cancelled) return;
          setStatus("idle");
        });

        // Avatar response transcripts (full, after each spoken turn).
        session.on(mod.AgentEventsEnum.AVATAR_TRANSCRIPTION, (...args: unknown[]) => {
          if (cancelled) return;
          const evt = args[0] as { text?: string } | undefined;
          if (!evt?.text) return;
          setMessages((prev) => {
            const copy = prev.slice();
            // If the last message was streaming, replace it; otherwise append.
            if (
              assistantStreamingRef.current &&
              copy.length &&
              copy[copy.length - 1].role === "assistant"
            ) {
              copy[copy.length - 1] = { role: "assistant", content: evt.text! };
            } else {
              copy.push({ role: "assistant", content: evt.text! });
            }
            return copy;
          });
          assistantStreamingRef.current = false;
          setStatus("ready");
        });

        // Streaming chunks of the avatar's response while it speaks.
        session.on(mod.AgentEventsEnum.AVATAR_TRANSCRIPTION_CHUNK, (...args: unknown[]) => {
          if (cancelled) return;
          const evt = args[0] as { text?: string } | undefined;
          if (!evt?.text) return;
          setMessages((prev) => {
            const copy = prev.slice();
            if (
              assistantStreamingRef.current &&
              copy.length &&
              copy[copy.length - 1].role === "assistant"
            ) {
              copy[copy.length - 1] = {
                role: "assistant",
                content: copy[copy.length - 1].content + evt.text!,
              };
            } else {
              copy.push({ role: "assistant", content: evt.text! });
              assistantStreamingRef.current = true;
            }
            return copy;
          });
        });

        await session.start();

        if (cancelled) {
          await session.stop().catch(() => {});
          return;
        }

        sessionRef.current = session;
      } catch (err) {
        console.error("[Receptionist] start error:", err);
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : "Could not start avatar");
          setStatus("error");
        }
      }
    };

    start();

    const onVisibility = () => {
      if (document.visibilityState === "hidden") setIsOpen(false);
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isOpen, resetIdleTimer, teardown]);

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!sessionRef.current) return;
      resetIdleTimer();

      setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
      setStatus("thinking");
      assistantStreamingRef.current = false;
      try {
        sessionRef.current.message(trimmed);
      } catch (err) {
        console.error("[Receptionist] message error:", err);
        setErrorMsg(err instanceof Error ? err.message : "Message error");
        setStatus("error");
      }
    },
    [resetIdleTimer]
  );

  const startRecording = () => {
    if (recognitionRef.current) return;
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      setErrorMsg("Voice input not supported in this browser. Type instead.");
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
      setIsRecording(false);
    };
    recognition.onend = () => {
      setIsRecording(false);
      recognitionRef.current = null;
    };
    try {
      recognition.start();
      recognitionRef.current = recognition;
      setIsRecording(true);
      resetIdleTimer();
    } catch (err) {
      console.error("[Receptionist] speech start error:", err);
    }
  };

  const stopRecording = () => {
    try {
      recognitionRef.current?.stop();
    } catch {}
  };

  const submitTyped = (e: React.FormEvent) => {
    e.preventDefault();
    if (!typed.trim()) return;
    const t = typed;
    setTyped("");
    sendMessage(t);
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        title="Talk to receptionist"
        style={{
          position: "fixed",
          right: 20,
          bottom: 20,
          padding: "12px 16px",
          background: "rgba(0, 0, 0, 0.55)",
          color: "white",
          border: "1px solid rgba(255,255,255,0.4)",
          borderRadius: 999,
          backdropFilter: "blur(10px)",
          fontSize: 14,
          fontFamily: "sans-serif",
          fontWeight: 600,
          cursor: "pointer",
          zIndex: 1900,
          boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 18 }}>🎙️</span>
        Talk to receptionist
      </button>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        right: 20,
        bottom: 20,
        width: 340,
        maxWidth: "calc(100vw - 40px)",
        height: 520,
        maxHeight: "calc(100vh - 40px)",
        background: "rgba(0, 0, 0, 0.45)",
        backdropFilter: "blur(20px)",
        border: "1px solid rgba(255,255,255,0.2)",
        borderRadius: 20,
        boxShadow: "0 25px 50px rgba(0,0,0,0.4)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        zIndex: 1950,
        fontFamily: "sans-serif",
        color: "white",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          borderBottom: "1px solid rgba(255,255,255,0.15)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>Receptionist</div>
        <button
          onClick={() => setIsOpen(false)}
          title="Close"
          style={{
            background: "rgba(255,255,255,0.2)",
            border: "none",
            borderRadius: "50%",
            width: 30,
            height: 30,
            color: "white",
            cursor: "pointer",
            fontSize: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ✕
        </button>
      </div>

      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "3 / 4",
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
        {status !== "ready" && status !== "thinking" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 13,
              color: "rgba(255,255,255,0.8)",
              background: "rgba(0,0,0,0.4)",
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
          flex: 1,
          overflowY: "auto",
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          fontSize: 13,
        }}
      >
        {messages.length === 0 && (
          <div style={{ color: "rgba(255,255,255,0.6)", fontStyle: "italic", textAlign: "center", marginTop: 12 }}>
            Tap the mic or type a message to start.
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "85%",
              background: m.role === "user" ? "rgba(0,112,243,0.7)" : "rgba(255,255,255,0.15)",
              padding: "6px 10px",
              borderRadius: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {m.content}
          </div>
        ))}
      </div>

      <form
        onSubmit={submitTyped}
        style={{
          display: "flex",
          gap: 6,
          padding: 10,
          borderTop: "1px solid rgba(255,255,255,0.15)",
        }}
      >
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            startRecording();
          }}
          onPointerUp={(e) => {
            e.preventDefault();
            stopRecording();
          }}
          onPointerLeave={() => {
            if (isRecording) stopRecording();
          }}
          title="Hold to speak"
          style={{
            width: 40,
            height: 40,
            borderRadius: 999,
            border: "none",
            background: isRecording ? "rgba(239,68,68,0.9)" : "rgba(255,255,255,0.2)",
            color: "white",
            cursor: "pointer",
            fontSize: 18,
            flexShrink: 0,
            touchAction: "none",
          }}
        >
          🎤
        </button>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={isRecording ? "Listening…" : "Type a message"}
          style={{
            flex: 1,
            padding: "0 12px",
            fontSize: 14,
            background: "rgba(255,255,255,0.1)",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: 999,
            color: "white",
            outline: "none",
            fontFamily: "sans-serif",
          }}
        />
        <button
          type="submit"
          disabled={!typed.trim() || status === "connecting"}
          style={{
            padding: "0 14px",
            height: 40,
            borderRadius: 999,
            border: "none",
            background: "rgba(0,112,243,0.9)",
            color: "white",
            fontWeight: 600,
            cursor: typed.trim() ? "pointer" : "default",
            opacity: typed.trim() ? 1 : 0.5,
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
