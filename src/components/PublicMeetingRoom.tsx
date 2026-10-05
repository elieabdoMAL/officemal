"use client";

import { useRef, useState } from "react";
import {
  LiveKitRoom,
  PreJoin,
  VideoConference,
  type LocalUserChoices,
} from "@livekit/components-react";
import "@livekit/components-styles";

// The public meeting room, shared by the 3D tour's pop-up (PublicMeetingModal)
// and the standalone /meet page. Two steps:
//   1. PreJoin — camera preview, mic/camera toggles, and a name field.
//   2. VideoConference — LiveKit's stock meeting UI: participant grid, mic,
//      camera, screen share, chat and a Leave button.
// The room itself and its limits live in /api/meeting/token.

type Props = {
  // Called when the guest leaves (Leave button, or the room closes on them).
  onLeave?: () => void;
};

type Session = { token: string; url: string; choices: LocalUserChoices };

export default function PublicMeetingRoom({ onLeave }: Props) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  // A refused connection can also report "disconnected"; only someone who got
  // in is actually leaving.
  const connectedRef = useRef(false);

  const join = async (choices: LocalUserChoices) => {
    setJoining(true);
    setError(null);
    try {
      const res = await fetch("/api/meeting/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: choices.username }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token || !data.url) {
        throw new Error(data.error || `Could not join (${res.status})`);
      }
      setSession({ token: data.token, url: data.url, choices });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join the meeting");
    } finally {
      setJoining(false);
    }
  };

  const leave = () => {
    setSession(null);
    if (connectedRef.current) onLeave?.();
    connectedRef.current = false;
  };

  if (!session) {
    return (
      <div
        data-lk-theme="default"
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: 16,
          boxSizing: "border-box",
          background: "transparent",
        }}
      >
        <PreJoin
          onSubmit={join}
          onError={(e) => setError(e.message)}
          joinLabel={joining ? "Joining…" : "Join meeting"}
          userLabel="Your name"
          // A kiosk is shared: don't prefill the next visitor with this
          // visitor's name or devices.
          persistUserChoices={false}
          defaults={{ username: "", videoEnabled: true, audioEnabled: true }}
        />
        {error && (
          <p style={{ margin: 0, color: "#ff8a8a", fontFamily: "sans-serif", fontSize: 14 }}>
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <LiveKitRoom
      data-lk-theme="default"
      serverUrl={session.url}
      token={session.token}
      connect
      video={
        session.choices.videoEnabled
          ? { deviceId: session.choices.videoDeviceId || undefined }
          : false
      }
      audio={
        session.choices.audioEnabled
          ? { deviceId: session.choices.audioDeviceId || undefined }
          : false
      }
      onConnected={() => (connectedRef.current = true)}
      onDisconnected={leave}
      // Connection refused (room full, network): back to the join screen with
      // the reason, rather than an empty call.
      onError={(e) => {
        setSession(null);
        setError(/full/i.test(e.message) ? "The meeting room is full right now." : e.message);
      }}
      style={{ height: "100%" }}
    >
      <VideoConference />
    </LiveKitRoom>
  );
}
