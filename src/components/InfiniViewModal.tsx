"use client";

import { useEffect, useState } from "react";

const WEBFRAME_URL = "https://shopping360.mobileappslabs.ca/";

export default function InfiniViewModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  useEffect(() => {
    const handleOpen = () => setIsOpen(true);
    window.addEventListener("open-infiniview", handleOpen);
    return () => window.removeEventListener("open-infiniview", handleOpen);
  }, []);

  const handleClose = () => setIsOpen(false);

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
        zIndex: 2100,
        pointerEvents: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          width: isMobile ? "98vw" : "85vw",
          height: isMobile ? "92vh" : "85vh",
          maxWidth: "1400px",
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
              fontWeight: 600,
              color: "white",
              fontFamily: "sans-serif",
              textShadow: "0 2px 10px rgba(0, 0, 0, 0.3)",
            }}
          >
            Infini-View
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
            title="Close"
          >
            ✕
          </button>
        </div>

        <iframe
          src={WEBFRAME_URL}
          allow="fullscreen"
          style={{
            flex: 1,
            width: "100%",
            border: "none",
            background: "white",
          }}
          title="Infini-View"
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
