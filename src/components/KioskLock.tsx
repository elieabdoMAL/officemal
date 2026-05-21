"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Fullscreen is handled by Chrome's --kiosk launch flag, NOT by this component.
// This component only blocks in-page escape vectors (keys, right-click,
// dblclick, drag-select, ctrl-zoom, browser back gesture) so the visitor can't
// navigate away inside the kiosk window.
//
// Admin toggle: Ctrl+Shift+Alt+K disables/re-enables the in-page blocks.
// (When unlocked you can use DevTools, right-click, etc. for debugging.)

const TOGGLE_COMBO = (e: KeyboardEvent) =>
  e.ctrlKey && e.shiftKey && e.altKey && e.key.toLowerCase() === "k";

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function shouldBlockKey(e: KeyboardEvent): boolean {
  const k = e.key;
  const ctrl = e.ctrlKey;
  const shift = e.shiftKey;
  const alt = e.altKey;

  if (k === "F5" || k === "F12") return true;
  if (k === "Backspace" && !isEditable(e.target)) return true;

  if (alt && (k === "ArrowLeft" || k === "ArrowRight" || k === "Home")) {
    return true;
  }

  if (ctrl && !shift) {
    const lower = k.toLowerCase();
    if (["r", "w", "t", "n", "l", "j", "h", "p", "u", "f", "d", "o"].includes(lower)) {
      return true;
    }
  }

  if (ctrl && shift) {
    const lower = k.toLowerCase();
    if (["r", "t", "i", "j", "c", "n", "w"].includes(lower)) {
      return true;
    }
  }

  return false;
}

export default function KioskLock() {
  const [unlocked, setUnlocked] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const unlockedRef = useRef(false);
  const hintTimerRef = useRef<number | null>(null);

  useEffect(() => {
    unlockedRef.current = unlocked;
  }, [unlocked]);

  const flashHint = useCallback((text: string) => {
    if (hintTimerRef.current !== null) {
      window.clearTimeout(hintTimerRef.current);
    }
    setHint(text);
    hintTimerRef.current = window.setTimeout(() => {
      setHint(null);
      hintTimerRef.current = null;
    }, 1500);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (TOGGLE_COMBO(e)) {
        e.preventDefault();
        e.stopPropagation();
        setUnlocked((prev) => {
          const next = !prev;
          flashHint(next ? "🔓 Kiosk unlocked" : "🔒 Kiosk locked");
          return next;
        });
        return;
      }
      if (unlockedRef.current) return;
      if (shouldBlockKey(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true } as EventListenerOptions);
  }, [flashHint]);

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      if (unlockedRef.current) return;
      e.preventDefault();
    };
    const onSelect = (e: Event) => {
      if (unlockedRef.current) return;
      if (isEditable(e.target)) return;
      e.preventDefault();
    };
    const onWheel = (e: WheelEvent) => {
      if (unlockedRef.current) return;
      if (e.ctrlKey) e.preventDefault();
    };
    const onDblClick = (e: MouseEvent) => {
      if (unlockedRef.current) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onContext, true);
    window.addEventListener("selectstart", onSelect, true);
    window.addEventListener("dragstart", onSelect, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    window.addEventListener("dblclick", onDblClick, true);
    return () => {
      window.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("selectstart", onSelect, true);
      window.removeEventListener("dragstart", onSelect, true);
      window.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      window.removeEventListener("dblclick", onDblClick, true);
    };
  }, []);

  useEffect(() => {
    history.pushState(null, "", location.href);
    const onPop = () => {
      if (unlockedRef.current) return;
      history.pushState(null, "", location.href);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return (
    <>
      {hint && (
        <div
          style={{
            position: "fixed",
            top: 20,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "10px 18px",
            background: "rgba(0,0,0,0.7)",
            color: "white",
            border: "1px solid rgba(255,255,255,0.25)",
            borderRadius: 999,
            fontFamily: "sans-serif",
            fontSize: 14,
            zIndex: 10001,
            backdropFilter: "blur(10px)",
            pointerEvents: "none",
          }}
        >
          {hint}
        </div>
      )}
    </>
  );
}
