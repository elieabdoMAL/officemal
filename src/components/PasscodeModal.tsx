"use client";

import { useEffect, useState } from "react";

const CORRECT_PASSCODE = "1234";
const TRIGGER_ID = "infiniview";

export default function PasscodeModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);

  // Mobile detection
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Listen for hotspot trigger
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const allowed = e.origin === window.location.origin || e.origin === "null";
      if (!allowed) return;

      const { type, triggerId } = e.data || {};

      if (type === "hotspot-trigger" && triggerId === TRIGGER_ID) {
        setIsOpen(true);
        setCode("");
        setError(false);
      }
    }

    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const handleClose = () => {
    setIsOpen(false);
    setCode("");
    setError(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (code === CORRECT_PASSCODE) {
      setIsOpen(false);
      setCode("");
      setError(false);
      window.dispatchEvent(new CustomEvent("open-infiniview"));
    } else {
      setError(true);
      setCode("");
    }
  };

  if (!isOpen) return null;

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
        zIndex: 2200,
        pointerEvents: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          width: isMobile ? "92vw" : "420px",
          maxWidth: "90vw",
          background: "rgba(0, 0, 0, 0.25)",
          backdropFilter: "blur(20px)",
          borderRadius: "20px",
          border: "1px solid rgba(255, 255, 255, 0.2)",
          boxShadow: "0 25px 50px rgba(0, 0, 0, 0.3)",
          padding: isMobile ? "24px 20px" : "32px 28px",
          animation: "slideUp 0.4s ease-out",
        }}
      >
        <button
          onClick={handleClose}
          style={{
            position: "absolute",
            top: "12px",
            right: "12px",
            background: "rgba(255, 255, 255, 0.2)",
            border: "none",
            borderRadius: "50%",
            width: "32px",
            height: "32px",
            cursor: "pointer",
            color: "white",
            fontSize: "14px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          title="Close"
        >
          ✕
        </button>

        <h2
          style={{
            margin: "0 0 8px",
            fontSize: isMobile ? "20px" : "24px",
            fontWeight: 600,
            color: "white",
            fontFamily: "sans-serif",
            textAlign: "center",
          }}
        >
          Enter Passcode
        </h2>
        <p
          style={{
            margin: "0 0 24px",
            fontSize: "14px",
            color: "rgba(255, 255, 255, 0.7)",
            textAlign: "center",
            fontFamily: "sans-serif",
          }}
        >
          Please enter the access code to continue
        </p>

        <form onSubmit={handleSubmit}>
          <input
            type="password"
            inputMode="numeric"
            autoFocus
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setError(false);
            }}
            placeholder="••••"
            style={{
              width: "100%",
              padding: "14px 16px",
              fontSize: "20px",
              textAlign: "center",
              letterSpacing: "8px",
              background: "rgba(255, 255, 255, 0.1)",
              border: error
                ? "1px solid rgba(255, 80, 80, 0.8)"
                : "1px solid rgba(255, 255, 255, 0.2)",
              borderRadius: "12px",
              color: "white",
              outline: "none",
              fontFamily: "sans-serif",
              boxSizing: "border-box",
            }}
          />

          {error && (
            <p
              style={{
                margin: "12px 0 0",
                fontSize: "13px",
                color: "rgba(255, 100, 100, 0.9)",
                textAlign: "center",
                fontFamily: "sans-serif",
              }}
            >
              Incorrect passcode. Try again.
            </p>
          )}

          <button
            type="submit"
            style={{
              width: "100%",
              marginTop: "20px",
              padding: "14px",
              fontSize: "16px",
              fontWeight: 600,
              background: "rgba(0, 112, 243, 0.9)",
              color: "white",
              border: "none",
              borderRadius: "12px",
              cursor: "pointer",
              fontFamily: "sans-serif",
              transition: "all 0.2s ease",
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.background = "rgba(0, 112, 243, 1)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.background = "rgba(0, 112, 243, 0.9)";
            }}
          >
            Unlock
          </button>
        </form>
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
