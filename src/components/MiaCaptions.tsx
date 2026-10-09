"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ASSISTANT_NAME, pick, type Lang } from "@/lib/assistant";

// Live captions (#16): what she says, and smaller above it what she heard.
// Fed from LiveKit's lk.transcription text streams by SimliLiveKitPanel.
//
// One line per speaker, the latest only: a kiosk caption is read in passing,
// not scrolled back through. Each fades a few seconds after its last word.

export type Speaker = "mia" | "visitor";

type Caption = {
  id: string;
  text: string;
  final: boolean;
  fading: boolean;
};

// How long a finished caption stays up. Hers scale with length so a long
// answer can be finished reading; the visitor's are an echo, shorter.
const HOLD_MS = { mia: 3500, visitor: 3000 };
const HOLD_PER_CHAR_MS = 35;
const HOLD_MAX_MS = 9000;
const FADE_MS = 600;
// A caption that never gets its final (the stream dropped) still goes.
const STALE_MS = 15000;

export function useCaptions() {
  const [captions, setCaptions] = useState<Record<Speaker, Caption | null>>({
    mia: null,
    visitor: null,
  });
  const timers = useRef<Record<Speaker, number[]>>({ mia: [], visitor: [] });

  const clearTimers = (who: Speaker) => {
    timers.current[who].forEach((t) => window.clearTimeout(t));
    timers.current[who] = [];
  };

  // Show `text` as `who`'s caption. The same id updates it in place (her words
  // arrive a few at a time); a new id replaces it.
  const update = useCallback((who: Speaker, id: string, text: string, final: boolean) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    clearTimers(who);
    setCaptions((prev) => ({ ...prev, [who]: { id, text: clean, final, fading: false } }));

    const hold = final
      ? Math.min(HOLD_MS[who] + clean.length * HOLD_PER_CHAR_MS, HOLD_MAX_MS)
      : STALE_MS;
    timers.current[who].push(
      window.setTimeout(() => {
        setCaptions((prev) =>
          prev[who]?.id === id ? { ...prev, [who]: { ...prev[who]!, fading: true } } : prev
        );
        timers.current[who].push(
          window.setTimeout(() => {
            setCaptions((prev) => (prev[who]?.id === id ? { ...prev, [who]: null } : prev));
          }, FADE_MS)
        );
      }, hold)
    );
  }, []);

  const clear = useCallback((who?: Speaker) => {
    const all: Speaker[] = who ? [who] : ["mia", "visitor"];
    all.forEach(clearTimers);
    setCaptions((prev) => {
      const next = { ...prev };
      all.forEach((w) => (next[w] = null));
      return next;
    });
  }, []);

  useEffect(
    () => () => {
      (["mia", "visitor"] as Speaker[]).forEach(clearTimers);
    },
    []
  );

  return { captions, update, clear };
}

const YOU = { fr: "Vous", en: "You" };
const LINE = 1.3; // line height, em

export default function MiaCaptions({
  captions,
  lang,
  showVisitor,
  bottom,
}: {
  captions: Record<Speaker, Caption | null>;
  lang: Lang | null;
  showVisitor: boolean;
  bottom: string;
}) {
  const visitor = showVisitor ? captions.visitor : null;
  const mia = captions.mia;
  const you = pick(lang, YOU).join(" / ");

  return (
    // Captions sit low in the frame, over her chest and the desk: her face is
    // in the upper half of the frame. aria-live so a screen reader (or any
    // assistive tech on the kiosk) gets them too; "polite" so it waits for a
    // pause instead of reading every word as it lands.
    <div
      aria-live="polite"
      style={{
        position: "absolute",
        left: "50%",
        bottom,
        transform: "translateX(-50%)",
        width: "min(88%, 62em)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "0.5vw",
        pointerEvents: "none",
        textAlign: "center",
      }}
    >
      {visitor && (
        <CaptionLine
          key={`v-${visitor.id}`}
          caption={visitor}
          label={you}
          fontSize="clamp(13px, 1.8vw, 30px)"
          color="rgba(255,255,255,0.85)"
          background="rgba(20,20,30,0.6)"
          italic
          lines={2}
        />
      )}
      {mia && (
        <CaptionLine
          key={`m-${mia.id}`}
          caption={mia}
          label={ASSISTANT_NAME}
          fontSize="clamp(16px, 2.5vw, 42px)"
          color="#fff"
          background="rgba(0,0,0,0.78)"
          // Two lines keep the box below her chin at the frame's usual size.
          lines={2}
        />
      )}
    </div>
  );
}

function CaptionLine({
  caption,
  label,
  fontSize,
  color,
  background,
  italic,
  lines,
}: {
  caption: Caption;
  label: string;
  fontSize: string;
  color: string;
  background: string;
  italic?: boolean;
  lines: number;
}) {
  // A long answer keeps its latest lines in view: the text box is capped at
  // `lines` whole lines and anchored to its bottom, so older lines slide off
  // the top. The padding sits outside it so no half-line peeks out.
  return (
    <div
      style={{
        fontSize,
        color,
        background,
        borderRadius: "0.45em",
        padding: "0.25em 0.7em",
        fontStyle: italic ? "italic" : "normal",
        fontWeight: italic ? 500 : 600,
        letterSpacing: "0.01em",
        opacity: caption.fading ? 0 : caption.final ? 1 : 0.95,
        transition: `opacity ${FADE_MS}ms ease`,
        boxShadow: "0 4px 18px rgba(0,0,0,0.35)",
      }}
    >
      <div
        style={{
          lineHeight: LINE,
          maxHeight: `${lines * LINE}em`,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
        }}
      >
        <span>
          <span style={{ fontWeight: 700, opacity: 0.75, fontStyle: "normal" }}>{label}: </span>
          {caption.text}
        </span>
      </div>
    </div>
  );
}
