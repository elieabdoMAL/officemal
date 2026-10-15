"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { findByLabel, postToEmbed, tourFrame, type TDVObject } from "@/lib/tour";

// Name of the 3DVista Web Frame hotspot that hosts the AI receptionist.
// Panorama overlays store the editor name under `data.label` (components on the
// skin use `data.name`), so the lookup below checks both.
const AI_FRAME_NAME = "AIWEB";

// Preferred route: a bridge the tour installs on itself (see README / the
// "Execute JavaScript" start action). Inside a 3DVista action `this` IS the
// player, so the tour can hand us the overlay without us guessing how to reach
// the player from out here.
const TOUR_BRIDGE = "setAI";

// Fallback route: two hidden 3DVista Containers whose click action is
// "Change Visibility -> AIWEB". Same trick Controls.tsx uses for mute/VR, and
// the only route that keeps working if the tour is ever served cross-origin
// (the direct player API below needs same-origin access to the iframe).
const SHOW_CONTAINER = "ShowAIHotspot";
const HIDE_CONTAINER = "HideAIHotspot";

// Overlay classes a Web Frame can be published as, depending on whether it sits
// flat in the panorama or on a quad. Container is included because a Web Frame
// dropped on the tour skin (not inside a panorama) publishes as one.
const FRAME_CLASSES = [
  "FramePanoramaOverlay",
  "QuadFramePanoramaOverlay",
  "HotspotPanoramaOverlay",
  "Container",
];

type BlazeIT = {
  triggerComponentByName?: (name: string, event: string) => boolean;
  triggerHotspotByName?: (name: string, event: string) => boolean;
};

function findAiFrame(): TDVObject | null {
  return findByLabel(FRAME_CLASSES, AI_FRAME_NAME);
}

// A panorama overlay has no `visible` property — 3DVista shows/hides it with
// `enabled` (AIWEB ships as enabled:false, i.e. hidden). Skin components use
// `visible`. Write whichever the object actually has.
function readShown(obj: TDVObject): boolean {
  const enabled = obj.get("enabled");
  if (typeof enabled === "boolean") return enabled;
  return obj.get("visible") !== false;
}

function writeShown(obj: TDVObject, next: boolean) {
  let wrote = false;
  for (const key of ["enabled", "visible"] as const) {
    if (typeof obj.get(key) === "boolean") {
      obj.set(key, next);
      wrote = true;
    }
  }
  if (!wrote) obj.set("enabled", next);
}

function triggerContainer(name: string): boolean {
  try {
    const win = tourFrame()?.contentWindow as unknown as { blazeIT?: BlazeIT } | null;
    const blazeIT =
      (window as unknown as { blazeIT?: BlazeIT }).blazeIT ?? win?.blazeIT;
    if (blazeIT?.triggerComponentByName?.(name, "click")) return true;
    if (blazeIT?.triggerHotspotByName?.(name, "click")) return true;
  } catch {
    // cross-origin — fall through to postMessage
  }
  tourFrame()?.contentWindow?.postMessage(
    { type: "trigger-component", componentName: name, eventType: "click", source: "AiToggle" },
    "*"
  );
  return false;
}

// The current tour unloads the Web Frame when AIWEB is hidden, but a build that
// only hides it would leave the iframe running and Mia talking behind an
// invisible panel. Tell the embed to go quiet as well.
function broadcastVisibility(visible: boolean) {
  postToEmbed([
    { type: "receptionist-visible", visible },
    { type: "receptionist-mute", muted: !visible },
  ]);
}

// How often to re-read AIWEB's real state. The tour can show or hide the frame
// with its own actions, which this button never hears about (#9: the icon then
// said "off" while she was on, and when her session ended the button's "hide"
// was skipped, leaving an empty frame the tour couldn't show again).
const SYNC_MS = 1000;

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
  backdropFilter: "blur(10px)",
  fontSize: "18px",
  transition: "all 0.3s ease",
};

export default function AiToggle({ initiallyVisible = false }: { initiallyVisible?: boolean }) {
  const [shown, setShown] = useState(initiallyVisible);
  // The frame is up but her session has ended (idle / max length): the embed
  // shows "Tap to talk" and holds no room. Tapping this button then starts a
  // session rather than hiding her.
  const [resting, setResting] = useState(false);

  // Follow the tour's real state, so the icon doesn't lie — AIWEB is
  // published hidden (enabled:false) and the tour may show or hide it on its
  // own. On a change we didn't make, tell the embed too: a build that keeps a
  // hidden frame loaded would otherwise keep (or never start) its session.
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    const sync = () => {
      const obj = findAiFrame();
      if (!obj) return;
      const isShown = readShown(obj);
      if (isShown !== shownRef.current) {
        shownRef.current = isShown;
        setShown(isShown);
        setResting(false);
        broadcastVisibility(isShown);
      }
    };
    const first = window.setTimeout(sync, 2500);
    const timer = window.setInterval(sync, SYNC_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  // Show or hide AIWEB.
  const setFrameShown = useCallback((next: boolean) => {
    // 1. The tour's own bridge, if its start action installed one.
    const bridge = (() => {
      try {
        return (tourFrame()?.contentWindow as unknown as Record<string, unknown> | null)?.[
          TOUR_BRIDGE
        ] as ((v: boolean) => void) | undefined;
      } catch {
        return undefined;
      }
    })();

    if (bridge) {
      bridge(next);
    } else {
      // 2. Reach the overlay ourselves.
      const obj = findAiFrame();
      if (obj) {
        writeShown(obj, next);
      } else {
        // 3. Click a hidden Container wired to a Change Visibility action.
        console.warn(`[AiToggle] '${AI_FRAME_NAME}' not found — using container fallback`);
        triggerContainer(next ? SHOW_CONTAINER : HIDE_CONTAINER);
      }
    }

    broadcastVisibility(next);
    shownRef.current = next;
    setShown(next);
    setResting(false);
  }, []);

  // The button. Shown but resting: a tap means "talk to her", not "hide her".
  const toggle = useCallback(() => {
    if (shown && resting) {
      postToEmbed([{ type: "receptionist-start" }]);
      setResting(false);
    } else {
      setFrameShown(!shown);
    }
  }, [shown, resting, setFrameShown]);

  // Let the tour drive the same switch from its own actions:
  //   Add Action -> Execute JavaScript -> window.parent.toggleAI()
  useEffect(() => {
    const api = {
      toggleAI: () => toggle(),
      // "Visible" means a live session: showing a resting frame wakes her.
      setAIVisible: (v: boolean) => {
        if (v && shown && resting) toggle();
        else if (v !== shown) setFrameShown(v);
      },
    };
    Object.assign(window, api);

    // The receptionist ended her session on her own (idle or max length) and
    // has left the room; the frame stays up with "Tap to talk" (#9). Show the
    // button as off so a tap on it reads as "talk to her" too.
    // Ended because a video call to staff was answered (#22, reason "call"):
    // the call goes on in its own window and she is hidden altogether, so the
    // AI button starts a fresh session once the call is over.
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const { type, reason } = (e.data ?? {}) as { type?: string; reason?: string };
      if (type === "receptionist-ended" && reason === "call") setFrameShown(false);
      else if (type === "receptionist-ended") setResting(true);
      else if (type === "receptionist-started") setResting(false);
    };
    window.addEventListener("message", onMessage);

    return () => {
      window.removeEventListener("message", onMessage);
      delete (window as unknown as Record<string, unknown>).toggleAI;
      delete (window as unknown as Record<string, unknown>).setAIVisible;
    };
  }, [toggle, setFrameShown, shown, resting]);

  const live = shown && !resting;

  // Bottom-right, opposite the Controls column (mute / VR / recenter) which
  // owns the bottom-left corner.
  return (
    <div
      style={{
        position: "fixed",
        right: "20px",
        bottom: "20px",
        zIndex: 2000,
        pointerEvents: "auto",
      }}
    >
      <button
        onClick={toggle}
        onMouseOver={(e) => {
          e.currentTarget.style.transform = "scale(1.05)";
          e.currentTarget.style.borderColor = "rgba(255, 255, 255, 1)";
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.transform = "scale(1)";
          e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.8)";
        }}
        style={buttonStyle}
        title={
          live ? "Hide the AI receptionist" : shown ? "Talk to the AI receptionist" : "Show the AI receptionist"
        }
      >
        <div
          style={{
            ...innerBase,
            background: live ? "rgba(0, 150, 255, 0.2)" : "rgba(255, 255, 255, 0.1)",
            color: live ? "rgba(0, 150, 255, 0.9)" : "rgba(255, 255, 255, 0.9)",
          }}
        >
          {live ? "🙋‍♀️" : "💬"}
        </div>
      </button>
    </div>
  );
}
