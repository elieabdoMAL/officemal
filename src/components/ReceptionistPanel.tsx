"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

type ChatMessage = { role: "user" | "assistant"; content: string };
type Status = "idle" | "connecting" | "ready" | "thinking" | "error";

type LiveAvatarSessionInstance = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  attach: (el: HTMLMediaElement) => void;
  message: (text: string) => string;
  on: (event: string, cb: (...args: unknown[]) => void) => unknown;
};

type Props = {
  // When true the session starts immediately on mount. When false the user
  // sees a "Start" button first — browsers block autoplay+getUserMedia inside
  // deeply-nested iframes without a user gesture, so the gesture is the safer
  // default for the 3DVista Web Frame embed.
  autoStart?: boolean;
};

export default function ReceptionistPanel({ autoStart = false }: Props) {
  const [active, setActive] = useState(autoStart);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typed, setTyped] = useState("");
  const [isRecording, setIsRecording] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<LiveAvatarSessionInstance | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const assistantStreamingRef = useRef(false);

  const teardown = useCallback(async () => {
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
    assistantStreamingRef.current = false;
  }, []);

  useEffect(() => {
    if (!active) {
      teardown();
      return;
    }

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

        session.on(mod.AgentEventsEnum.AVATAR_TRANSCRIPTION, (...args: unknown[]) => {
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
              copy[copy.length - 1] = { role: "assistant", content: evt.text! };
            } else {
              copy.push({ role: "assistant", content: evt.text! });
            }
            return copy;
          });
          assistantStreamingRef.current = false;
          setStatus("ready");
        });

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
        console.error("[ReceptionistPanel] start error:", err);
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : "Could not start avatar");
          setStatus("error");
        }
      }
    };

    start();

    // HeyGen counts a tab close as a "still alive" session until its server
    // timeout — that eats the concurrency cap. Synchronously stop on unload.
    const onUnload = () => {
      try {
        localSession?.stop();
      } catch {}
    };
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);

    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
      const s = localSession;
      if (s) {
        s.stop().catch(() => {});
      }
    };
  }, [active, teardown]);

  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!sessionRef.current) return;

    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setStatus("thinking");
    assistantStreamingRef.current = false;
    try {
      sessionRef.current.message(trimmed);
    } catch (err) {
      console.error("[ReceptionistPanel] message error:", err);
      setErrorMsg(err instanceof Error ? err.message : "Message error");
      setStatus("error");
    }
  }, []);

  const startRecording = () => {
    if (recognitionRef.current) return;
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      setErrorMsg("Voice input not supported. Type instead.");
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
    } catch (err) {
      console.error("[ReceptionistPanel] speech start error:", err);
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
          flex: "0 0 55%",
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
          flex: 1,
          overflowY: "auto",
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          fontSize: 13,
          minHeight: 0,
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
          flexShrink: 0,
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
            minWidth: 0,
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
            flexShrink: 0,
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
