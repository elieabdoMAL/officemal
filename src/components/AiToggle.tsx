"use client";

import { useCallback, useEffect, useState } from "react";

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

type TDVObject = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
};

type BlazeIT = {
  triggerComponentByName?: (name: string, event: string) => boolean;
  triggerHotspotByName?: (name: string, event: string) => boolean;
};

function tourFrame(): HTMLIFrameElement | null {
  return document.querySelector('iframe[src*="3dvista"]');
}

// `var tour` is a global inside the published tour (script.js line 5); the
// player hangs off it once TDV.Tour has initialized.
function getPlayer(): { getByClassName?: (cls: string) => TDVObject[] } | null {
  try {
    const win = tourFrame()?.contentWindow as unknown as {
      tour?: { player?: unknown; _player?: unknown };
      rootPlayer?: unknown;
    } | null;
    if (!win) return null;
    return (win.tour?.player ?? win.tour?._player ?? win.rootPlayer ?? null) as ReturnType<
      typeof getPlayer
    >;
  } catch {
    return null; // cross-origin — caller falls back to the containers
  }
}

// 3DVista generates opaque ids (overlay_A9B5493B_...), so the editor name is the
// only handle worth coding against. It lives on the object's `data` bag — as
// `label` for panorama overlays, `name` for skin components.
function findAiFrame(): TDVObject | null {
  const player = getPlayer();
  if (!player?.getByClassName) return null;

  for (const cls of FRAME_CLASSES) {
    let items: TDVObject[] = [];
    try {
      items = player.getByClassName(cls) || [];
    } catch {
      continue;
    }
    for (const item of items) {
      const data = item.get?.("data") as { name?: string; label?: string } | undefined;
      if (data?.label === AI_FRAME_NAME || data?.name === AI_FRAME_NAME) return item;
    }
  }
  return null;
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

// Hiding a Web Frame doesn't unload it — the iframe keeps running and Mia keeps
// talking behind an invisible panel. Tell the embed to go quiet as well.
function broadcastVisibility(visible: boolean) {
  const send = (win: Window | null) => {
    if (!win) return;
    try {
      win.postMessage({ type: "receptionist-visible", visible }, "*");
      win.postMessage({ type: "receptionist-mute", muted: !visible }, "*");
    } catch {}
  };
  const frame = tourFrame();
  send(frame?.contentWindow ?? null);
  // Reach the nested receptionist iframe directly (same-origin) so we don't
  // depend on the tour forwarding the message.
  try {
    frame?.contentDocument
      ?.querySelectorAll<HTMLIFrameElement>("iframe")
      .forEach((f) => send(f.contentWindow));
  } catch {}
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
  backdropFilter: "blur(10px)",
  fontSize: "18px",
  transition: "all 0.3s ease",
};

export default function AiToggle({ initiallyVisible = false }: { initiallyVisible?: boolean }) {
  const [shown, setShown] = useState(initiallyVisible);

  // Adopt the tour's real state once it has loaded, so the icon doesn't lie —
  // AIWEB is published hidden (enabled:false).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const obj = findAiFrame();
      if (obj) setShown(readShown(obj));
    }, 2500);
    return () => window.clearTimeout(timer);
  }, []);

  const toggle = useCallback(() => {
    const next = !shown;

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
    setShown(next);
  }, [shown]);

  // Let the tour drive the same switch from its own actions:
  //   Add Action -> Execute JavaScript -> window.parent.toggleAI()
  useEffect(() => {
    const api = {
      toggleAI: () => toggle(),
      setAIVisible: (v: boolean) => {
        if (v !== shown) toggle();
      },
    };
    Object.assign(window, api);
    return () => {
      delete (window as unknown as Record<string, unknown>).toggleAI;
      delete (window as unknown as Record<string, unknown>).setAIVisible;
    };
  }, [toggle, shown]);

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
        title={shown ? "Hide the AI receptionist" : "Show the AI receptionist"}
      >
        <div
          style={{
            ...innerBase,
            background: shown ? "rgba(0, 150, 255, 0.2)" : "rgba(255, 255, 255, 0.1)",
            color: shown ? "rgba(0, 150, 255, 0.9)" : "rgba(255, 255, 255, 0.9)",
          }}
        >
          {shown ? "🙋‍♀️" : "💬"}
        </div>
      </button>
    </div>
  );
}
