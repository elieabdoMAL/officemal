"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { findByLabel, tourFrame, type TDVObject } from "@/lib/tour";

// Mia in VR.
//
// 3DVista hides every Web Frame in VR (its player only shows them when not
// inVR), so the AIWEB frame that carries Mia normally vanishes. Video hotspots
// do render in VR, and the player accepts a live MediaStream as a video source
// (`srcObject` on a VideoResourceLevel). So in VR:
//   1. Mia's session runs in a hidden iframe on THIS page, outside the tour,
//      where 3DVista can't hide or unload it — her voice and the mic keep
//      working there.
//   2. Her live video is handed to a video hotspot in the tour (AIVR), whose
//      own chroma key removes her studio backdrop.
//
// Started and stopped from the tour by a VR-clickable hotspot:
//   window.parent.postMessage({ type: "hotspot-trigger", triggerId: "mia-vr" }, "*");
// Her session ends on its own the usual way (2 min idle / 10 min max); the
// embed then reports "receptionist-ended" and this tears down.
//
// Relies on 3DVista internals (player object, level `srcObject`). Re-test after
// upgrading 3DVista.

const TRIGGER_ID = "mia-vr";

// The 3DVista video hotspot Mia plays in. Set up in the editor with any short
// placeholder video, chroma colour #557455, threshold ~0.05, and hidden.
const VR_OVERLAY_LABEL = "AIVR";
const VIDEO_CLASSES = ["VideoPanoramaOverlay", "QuadVideoPanoramaOverlay"];

// How long to wait for her video before giving up (token, room, worker, Simli).
const STREAM_TIMEOUT_MS = 30000;

export default function MiaVr() {
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  activeRef.current = active;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const overlayRef = useRef<TDVObject | null>(null);

  // Hide the hotspot and drop the stream. Hidden first, so the placeholder
  // video the hotspot falls back to never shows.
  const detach = useCallback(() => {
    const overlay = overlayRef.current;
    overlayRef.current = null;
    if (!overlay) return;
    overlay.set("enabled", false);
    levelOf(overlay)?.set("srcObject", null);
  }, []);

  const stop = useCallback(() => {
    detach();
    setActive(false); // unmounts the hidden iframe, which leaves the room
  }, [detach]);

  // Toggle from the tour hotspot.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // Same origin, or the 3DVista iframe (which can post as "null").
      const allowed = e.origin === window.location.origin || e.origin === "null";
      if (!allowed) return;
      const { type, triggerId } = (e.data || {}) as { type?: string; triggerId?: string };
      if (type === "hotspot-trigger" && triggerId === TRIGGER_ID) {
        if (activeRef.current) stop();
        else setActive(true);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [stop]);

  // Her session ended on its own (idle / max length): the embed in our hidden
  // iframe says so. Messages from the normal AIWEB embed are AiToggle's job.
  useEffect(() => {
    if (!active) return;
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.source !== iframeRef.current?.contentWindow) return;
      if ((e.data as { type?: string })?.type === "receptionist-ended") stop();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [active, stop]);

  // Once her video arrives in the hidden iframe, put it on the AIVR hotspot.
  useEffect(() => {
    if (!active) return;

    // Only one Mia at a time: end the normal (AIWEB) session if it's running.
    (window as unknown as { setAIVisible?: (v: boolean) => void }).setAIVisible?.(false);

    const attach = (track: MediaStreamTrack, width: number, height: number): boolean => {
      const overlay = findByLabel(VIDEO_CLASSES, VR_OVERLAY_LABEL);
      const level = overlay && levelOf(overlay);
      const tourWin = tourFrame()?.contentWindow as (Window & typeof globalThis) | null;
      if (!overlay || !level || !tourWin) {
        console.warn(`[MiaVr] no '${VR_OVERLAY_LABEL}' video hotspot in the tour`);
        return false;
      }
      // The player checks `instanceof MediaStream` against its own frame's
      // class, so a stream built in another frame is ignored and the
      // placeholder file plays instead. Rebuild it in the tour's frame.
      const stream = new tourWin.MediaStream([track]);
      level.set("width", width);
      level.set("height", height);
      level.set("srcObject", stream);
      overlay.set("enabled", true);
      overlayRef.current = overlay;
      return true;
    };

    const started = Date.now();
    const timer = window.setInterval(() => {
      const video = iframeRef.current?.contentDocument?.querySelector("video");
      const track = (video?.srcObject as MediaStream | null)?.getVideoTracks()[0];
      if (!track || !video?.videoWidth) {
        if (Date.now() - started > STREAM_TIMEOUT_MS) {
          console.warn("[MiaVr] no video from Mia — giving up");
          window.clearInterval(timer);
          stop();
        }
        return;
      }
      window.clearInterval(timer);
      if (!attach(track, video.videoWidth, video.videoHeight)) stop();
    }, 500);

    return () => window.clearInterval(timer);
  }, [active, stop]);

  // Leaving the page mid-session: don't leave the hotspot pointing at a dead
  // stream.
  useEffect(() => detach, [detach]);

  if (!active) return null;

  // Hidden, but not display:none — the media inside must keep playing.
  return (
    <iframe
      ref={iframeRef}
      src="/receptionist-embed"
      allow="microphone; autoplay"
      title="Mia (VR)"
      aria-hidden
      style={{
        position: "fixed",
        width: 1,
        height: 1,
        left: -10,
        top: -10,
        opacity: 0,
        border: "none",
        pointerEvents: "none",
      }}
    />
  );
}

// The hotspot's first video level — the one the player plays.
function levelOf(overlay: TDVObject): TDVObject | null {
  const resource = overlay.get("video") as TDVObject | undefined;
  const levels = resource?.get("levels") as TDVObject[] | undefined;
  return levels?.[0] ?? null;
}
