"use client";

import { useEffect, useState } from "react";
import PublicMeetingRoom from "@/components/PublicMeetingRoom";
import { devTimeout } from "@/lib/devTimeout";

const TRIGGER_ID = "public-meeting";

// Kiosk only: a pop-up left on the join screen keeps the camera preview running
// and hides the tour from the next visitor, so close it after this long with no
// touch, mouse or key. Plenty of time to type a name. Once in a call,
// MeetingLimits takes over (the /meet page has its own tab, so it's left alone).
const PREJOIN_IDLE_CLOSE_MS = 2 * 60_000;
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel"] as const;

// Pop-up for the public meeting room, opened from the 3D tour by a hotspot
// action that posts:
//   window.parent.postMessage({ type: "hotspot-trigger", triggerId: "public-meeting" }, "*");
// Same look as MeetingModal; the call itself is PublicMeetingRoom, which the
// standalone /meet page also uses, so tour visitors and outside guests meet in
// the same room.
export default function PublicMeetingModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [inCall, setInCall] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      // Same origin, or the 3DVista iframe (which can post as "null").
      const allowed = e.origin === window.location.origin || e.origin === "null";
      if (!allowed) return;

      const { type, triggerId } = e.data || {};
      if (type === "hotspot-trigger" && triggerId === TRIGGER_ID) setIsOpen(true);
    }

    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // Idle close for the join screen; any activity restarts the clock. Capture
  // phase, so inputs that stop propagation still count.
  useEffect(() => {
    if (!isOpen || inCall) return;
    const idleMs = devTimeout("prejoinIdleMs", PREJOIN_IDLE_CLOSE_MS);
    let timer = setTimeout(() => setIsOpen(false), idleMs);
    const onActivity = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setIsOpen(false), idleMs);
    };
    for (const e of ACTIVITY_EVENTS) {
      window.addEventListener(e, onActivity, { capture: true, passive: true });
    }
    return () => {
      clearTimeout(timer);
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity, { capture: true });
    };
  }, [isOpen, inCall]);

  // Unmounting PublicMeetingRoom disconnects from the room, so closing the
  // pop-up is also how a guest leaves.
  const close = () => {
    setIsOpen(false);
    setInCall(false);
  };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(255, 255, 255, 0.1)",
        backdropFilter: "blur(12px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2100,
        pointerEvents: "auto",
      }}
    >
      {/* No click-outside-to-close: a stray tap on the backdrop would drop
          someone out of a live call. Only the ✕ and Leave buttons close it. */}
      <div
        style={{
          position: "relative",
          width: isMobile ? "98vw" : "85vw",
          height: isMobile ? "92vh" : "80vh",
          maxWidth: "1200px",
          background: "rgba(0, 0, 0, 0.55)",
          backdropFilter: "blur(20px)",
          borderRadius: "20px",
          border: "1px solid rgba(255, 255, 255, 0.2)",
          boxShadow: "0 25px 50px rgba(0, 0, 0, 0.3)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: isMobile ? "12px 16px" : "14px 20px",
            borderBottom: "1px solid rgba(255, 255, 255, 0.15)",
            flexShrink: 0,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: isMobile ? "16px" : "20px",
              fontWeight: "600",
              color: "white",
              fontFamily: "sans-serif",
              textShadow: "0 2px 10px rgba(0, 0, 0, 0.3)",
            }}
          >
            Public Meeting Room
          </h2>

          <button
            onClick={close}
            style={{
              background: "rgba(255, 255, 255, 0.2)",
              border: "none",
              borderRadius: "50%",
              width: isMobile ? "36px" : "40px",
              height: isMobile ? "36px" : "40px",
              cursor: "pointer",
              fontSize: isMobile ? "16px" : "18px",
              color: "white",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="Leave and close"
          >
            ✕
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          <PublicMeetingRoom onLeave={close} onInCallChange={setInCall} />
        </div>
      </div>
    </div>
  );
}
