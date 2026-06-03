"use client";

import ImmersiveReceptionistPanel from "@/components/ImmersiveReceptionistPanel";

// Standalone embedded route rendered inside a 3DVista Web Frame hotspot.
// Renders the chroma-keyed avatar full-bleed against a transparent background
// so it appears to stand inside the panorama. Hold the frame to talk.
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
      <ImmersiveReceptionistPanel />
    </div>
  );
}
