"use client";

import { useEffect, useState } from "react";

export default function MeetingModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [notified, setNotified] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // Mobile detection
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Listen for hotspot-trigger with triggerId "meeting-room"
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      // Allow messages from same origin or from 3DVista iframe
      const allowed = e.origin === window.location.origin || e.origin === "null";
      if (!allowed) return;

      const { type, triggerId } = e.data || {};

      if (type === "hotspot-trigger" && triggerId === "meeting-room") {
        setIsOpen(true);
        setNotified(false);
      }
    }

    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // Send admin notification once per open session
  useEffect(() => {
    if (!isOpen || notified) return;

    fetch("/api/notify-meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorName: "A visitor" }),
    })
      .then((res) => res.json())
      .then((data) => {
        console.log("[MeetingModal] Notification sent", data);
        setNotified(true);
      })
      .catch((err) => {
        console.error("[MeetingModal] Failed to send notification", err);
        setNotified(true); // prevent retry spam
      });
  }, [isOpen, notified]);

  const handleClose = () => setIsOpen(false);

  if (!isOpen) return null;

  const jitsiUrl =
    process.env.NEXT_PUBLIC_JITSI_ROOM_URL ?? "https://meet.jit.si/officemal-meeting";

  return (
    <div
      onClick={handleClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(255, 255, 255, 0.1)",
        backdropFilter: "blur(12px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2100,
        transition: "opacity 0.3s ease",
        pointerEvents: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          width: isMobile ? "98vw" : "85vw",
          height: isMobile ? "92vh" : "80vh",
          maxWidth: "1200px",
          background: "rgba(0, 0, 0, 0.15)",
          backdropFilter: "blur(20px)",
          borderRadius: "20px",
          border: "1px solid rgba(255, 255, 255, 0.2)",
          boxShadow: "0 25px 50px rgba(0, 0, 0, 0.3)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          animation: "slideUp 0.4s ease-out",
        }}
      >
        {/* Header */}
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
            Meeting Room
          </h2>

          <button
            onClick={handleClose}
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
              transition: "all 0.2s ease",
              backdropFilter: "blur(10px)",
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.background = "rgba(255, 255, 255, 0.3)";
              e.currentTarget.style.transform = "scale(1.1)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.background = "rgba(255, 255, 255, 0.2)";
              e.currentTarget.style.transform = "scale(1)";
            }}
            title="Close meeting room"
          >
            ✕
          </button>
        </div>

        {/* Jitsi iframe */}
        <iframe
          src={jitsiUrl}
          allow="camera; microphone; fullscreen; display-capture; autoplay"
          style={{
            flex: 1,
            width: "100%",
            border: "none",
            background: "#1a1a2e",
          }}
          title="OfficeMal Meeting Room"
        />
      </div>

      <style jsx>{`
        @keyframes slideUp {
          from {
            opacity: 0;
            transform: scale(0.95) translateY(20px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }
      `}</style>
    </div>
  );
}
