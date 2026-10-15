"use client";

import { ASSISTANT_NAME, pick, type Lang } from "@/lib/assistant";

// What the visitor needs to do to talk to her, when it isn't simply "talk":
//   - paused  (#24, #25): she was told to stop and waits for her name.
//   - idle    : in a session, but nobody has spoken for a while.
//   - resting (#9): no session (she timed out); a tap starts a new one.
// All three sit at the bottom of the frame, where the turn pill is, and are
// buttons: a tap does what the text says.

export type BannerKind = "paused" | "idle" | "resting";

const TEXT: Record<BannerKind, { fr: string; en: string }> = {
  paused: {
    fr: `Je m'appelle ${ASSISTANT_NAME} — dites mon nom pour me parler`,
    en: `My name is ${ASSISTANT_NAME} — say my name to talk to me`,
  },
  idle: {
    fr: `Dites « ${ASSISTANT_NAME} » ou touchez pour parler`,
    en: `Say “${ASSISTANT_NAME}” or tap to talk`,
  },
  resting: {
    fr: `Touchez pour parler à ${ASSISTANT_NAME}`,
    en: `Tap to talk to ${ASSISTANT_NAME}`,
  },
};

const ICON: Record<BannerKind, string> = { paused: "⏸", idle: "💬", resting: "👋" };

export default function MiaBanner({
  kind,
  lang,
  onTap,
}: {
  kind: BannerKind;
  // The resting prompt has no session, so no known language: always both.
  lang: Lang | null;
  onTap: () => void;
}) {
  const lines = pick(kind === "resting" ? null : lang, TEXT[kind]);
  const big = kind !== "idle";

  return (
    <button
      onClick={onTap}
      style={{
        position: "absolute",
        left: "50%",
        bottom: "1.2vw",
        transform: "translateX(-50%)",
        maxWidth: "62%",
        padding: big ? "0.9vw 2.2vw" : "0.6vw 1.6vw",
        borderRadius: big ? "1.4vw" : 999,
        border: "2px solid rgba(255,255,255,0.85)",
        background: kind === "resting" ? "rgba(0,120,220,0.92)" : "rgba(0,0,0,0.72)",
        color: "white",
        fontFamily: "inherit",
        fontSize: big ? "clamp(15px, 2.2vw, 36px)" : "clamp(12px, 1.6vw, 26px)",
        fontWeight: 700,
        lineHeight: 1.3,
        textAlign: "center",
        cursor: "pointer",
        pointerEvents: "auto",
        boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
        animation: kind === "resting" ? "mia-breathe 2.8s ease-in-out infinite" : undefined,
      }}
    >
      {lines.map((t, i) => (
        <div
          key={t}
          style={i ? { fontWeight: 500, fontSize: "0.78em", opacity: 0.9, marginTop: "0.2em" } : undefined}
        >
          {i === 0 && <span aria-hidden>{ICON[kind]} </span>}
          {t}
        </div>
      ))}
      <style>{`@keyframes mia-breathe { 0%, 100% { transform: translateX(-50%) scale(1); } 50% { transform: translateX(-50%) scale(1.04); } }`}</style>
    </button>
  );
}
