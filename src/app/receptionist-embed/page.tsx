"use client";

import ImmersiveReceptionistPanel from "@/components/ImmersiveReceptionistPanel";
import SimliReceptionistPanel from "@/components/SimliReceptionistPanel";

// Switch the avatar backend without code changes:
//   NEXT_PUBLIC_AVATAR_PROVIDER=simli      -> Simli + Haiku (Auto/E2E)
//   anything else (default)                -> LiveAvatar (HeyGen) FULL mode
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
      {PROVIDER === "simli" ? (
        <SimliReceptionistPanel autoStart />
      ) : (
        <ImmersiveReceptionistPanel />
      )}
    </div>
  );
}
