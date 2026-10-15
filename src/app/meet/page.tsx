"use client";

import { useState } from "react";
import PublicMeetingRoom from "@/components/PublicMeetingRoom";

// Shareable link to the public meeting room (officemal.mobileappslabs.ca/meet),
// for guests outside the 3D tour. Same room as the tour's "public-meeting"
// hotspot, so both sides meet. Delete this page to make the room tour-only.
export default function MeetPage() {
  const [left, setLeft] = useState(false);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#111",
        color: "white",
        fontFamily: "sans-serif",
      }}
    >
      {left ? (
        <div
          style={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
          }}
        >
          <p style={{ margin: 0, fontSize: 18 }}>You left the meeting.</p>
          <button
            onClick={() => setLeft(false)}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              background: "#0070f3",
              color: "white",
              fontSize: 15,
              cursor: "pointer",
            }}
          >
            Rejoin
          </button>
        </div>
      ) : (
        <PublicMeetingRoom onLeave={() => setLeft(true)} />
      )}
    </div>
  );
}
