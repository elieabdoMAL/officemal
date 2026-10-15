"use client";

import { useEffect } from "react";

// Mia can open the meeting rooms for the visitor (#2): her worker's
// press_button arrives from the receptionist embed as a "receptionist-press"
// window message (docs/screen-protocol.md, section 5). The pop-ups already
// open on the tour's own "hotspot-trigger" messages, so pressing for Mia is
// re-posting exactly what a tap on the hotspot posts — MeetingModal and
// PublicMeetingModal need no change and can't drift from the tap's behaviour.
// (mute / unmute / vr / recenter are handled by Controls itself, where the
// button state lives.)
const HOTSPOT_FOR_BUTTON: Record<string, string> = {
  meeting_room: "meeting-room",
  public_meeting: "public-meeting",
};

export default function MiaPressRouter() {
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const { type, button } = (e.data ?? {}) as { type?: string; button?: string };
      if (type !== "receptionist-press" || !button) return;
      const triggerId = HOTSPOT_FOR_BUTTON[button];
      if (!triggerId) return;
      console.log("[MiaPress]", button, "->", triggerId);
      window.postMessage({ type: "hotspot-trigger", triggerId }, window.location.origin);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return null;
}
