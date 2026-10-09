"use client";

import ImmersiveReceptionistPanel from "@/components/ImmersiveReceptionistPanel";
import SimliReceptionistPanel from "@/components/SimliReceptionistPanel";
import SimliLiveKitPanel from "@/components/SimliLiveKitPanel";
import StaffCallModal from "@/components/StaffCallModal";

// Switch the avatar backend without code changes:
//   NEXT_PUBLIC_AVATAR_PROVIDER=simli-livekit -> Simli Trinity face via a
//        self-hosted LiveKit worker (agent-worker/); Gemini + Deepgram brain.
//   NEXT_PUBLIC_AVATAR_PROVIDER=simli         -> Simli Auto + Haiku (Daily;
//        Legacy faces only — kept for rollback)
//   anything else (default)                   -> LiveAvatar (HeyGen) FULL mode
const PROVIDER = process.env.NEXT_PUBLIC_AVATAR_PROVIDER;

// Standalone embedded route rendered inside a 3DVista Web Frame hotspot.
// Renders the avatar full-bleed so it appears to stand inside the panorama.
// LiveAvatar variant chroma-keys its green screen; the Simli variant renders
// the room directly (Simli faces come on their own background).
export default function ReceptionistEmbedPage() {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "transparent",
        overflow: "hidden",
      }}
    >
      {PROVIDER === "simli-livekit" ? (
        <>
          <SimliLiveKitPanel />
          {/* A video call to staff (#22) opens on the kiosk page; this one
              only when the embed is opened on its own (tests). */}
          <StaffCallModal topOnly />
        </>
      ) : PROVIDER === "simli" ? (
        <SimliReceptionistPanel />
      ) : (
        <ImmersiveReceptionistPanel />
      )}
    </div>
  );
}
