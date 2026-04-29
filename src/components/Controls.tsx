"use client";

import { useCallback, useState } from "react";
import type { BlazeITAPI } from "@/types/blazeIT";

const CONTAINER_NAMES = {
  mute: "MuteHotspot",
  unmute: "UnmuteHotspot",
  vrEnter: "VRHotspot",
  vrExit: "ExitVRHotspot",
  recenter: "RecenterHotspot",
} as const;

function getBlazeIT(): BlazeITAPI | null {
  if (typeof window === "undefined") return null;

  const direct = (window as unknown as { blazeIT?: BlazeITAPI }).blazeIT;
  if (direct) return direct;

  const iframe = document.querySelector(
    'iframe[src*="3dvista"]'
  ) as HTMLIFrameElement | null;
  if (iframe?.contentWindow) {
    try {
      const fromFrame = (iframe.contentWindow as unknown as { blazeIT?: BlazeITAPI })
        .blazeIT;
      if (fromFrame) return fromFrame;
    } catch {
      // cross-origin — ignore, will fall back to postMessage
    }
  }
  return null;
}

function trigger(containerName: string) {
  const blazeIT = getBlazeIT();
  if (blazeIT?.triggerComponentByName) {
    const ok = blazeIT.triggerComponentByName(containerName, "click");
    if (ok) return true;
  }
  if (blazeIT?.triggerHotspotByName) {
    const ok = blazeIT.triggerHotspotByName(containerName, "click");
    if (ok) return true;
  }

  const iframe = document.querySelector(
    'iframe[src*="3dvista"]'
  ) as HTMLIFrameElement | null;
  iframe?.contentWindow?.postMessage(
    {
      type: "trigger-component",
      componentName: containerName,
      eventType: "click",
      source: "Controls",
    },
    "*"
  );
  return false;
}

const buttonStyle: React.CSSProperties = {
  background: "transparent",
  border: "3px solid rgba(255, 255, 255, 0.8)",
  borderRadius: "12px",
  padding: 0,
  cursor: "pointer",
  transition: "all 0.3s ease",
  boxShadow: "0 8px 32px rgba(0, 0, 0, 0.2)",
  position: "relative",
  overflow: "hidden",
};

const innerBase: React.CSSProperties = {
  width: "45px",
  height: "45px",
  borderRadius: "8px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(255, 255, 255, 0.1)",
  backdropFilter: "blur(10px)",
  fontSize: "18px",
  color: "rgba(255, 255, 255, 0.9)",
  transition: "all 0.3s ease",
};

export default function Controls() {
  const [isMuted, setIsMuted] = useState(false);
  const [isVRActive, setIsVRActive] = useState(false);

  const toggleMute = useCallback(() => {
    const next = !isMuted;
    trigger(next ? CONTAINER_NAMES.mute : CONTAINER_NAMES.unmute);

    document.querySelectorAll("audio, video").forEach((el) => {
      if (el instanceof HTMLAudioElement || el instanceof HTMLVideoElement) {
        el.muted = next;
      }
    });

    setIsMuted(next);
  }, [isMuted]);

  const toggleVR = useCallback(() => {
    const next = !isVRActive;
    trigger(next ? CONTAINER_NAMES.vrEnter : CONTAINER_NAMES.vrExit);
    setIsVRActive(next);
  }, [isVRActive]);

  const recenter = useCallback(() => {
    trigger(CONTAINER_NAMES.recenter);
  }, []);

  const hover = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.transform = "scale(1.05)";
    e.currentTarget.style.boxShadow = "0 12px 40px rgba(0, 0, 0, 0.3)";
    e.currentTarget.style.borderColor = "rgba(255, 255, 255, 1)";
  };
  const unhover = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.transform = "scale(1)";
    e.currentTarget.style.boxShadow = "0 8px 32px rgba(0, 0, 0, 0.2)";
    e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.8)";
  };

  return (
    <div
      style={{
        position: "fixed",
        left: "20px",
        bottom: "20px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        alignItems: "center",
        zIndex: 2000,
        pointerEvents: "auto",
      }}
    >
      <button
        onClick={toggleMute}
        onMouseOver={hover}
        onMouseOut={unhover}
        style={buttonStyle}
        title={isMuted ? "Unmute Audio" : "Mute Audio"}
      >
        <div
          style={{
            ...innerBase,
            background: isMuted
              ? "rgba(239, 68, 68, 0.2)"
              : "rgba(255, 255, 255, 0.1)",
            color: isMuted ? "rgba(239, 68, 68, 0.9)" : "rgba(255, 255, 255, 0.9)",
          }}
        >
          {isMuted ? "🔇" : "🔊"}
        </div>
      </button>

      <button
        onClick={toggleVR}
        onMouseOver={hover}
        onMouseOut={unhover}
        style={buttonStyle}
        title={isVRActive ? "Exit VR Mode" : "Enter VR Mode"}
      >
        <div
          style={{
            ...innerBase,
            background: isVRActive
              ? "rgba(0, 150, 255, 0.2)"
              : "rgba(255, 255, 255, 0.1)",
            color: isVRActive ? "rgba(0, 150, 255, 0.9)" : "rgba(255, 255, 255, 0.9)",
          }}
        >
          🥽
        </div>
      </button>

      <button
        onClick={recenter}
        onMouseOver={hover}
        onMouseOut={unhover}
        style={buttonStyle}
        title="Recenter Camera"
      >
        <div style={innerBase}>⟳</div>
      </button>
    </div>
  );
}
