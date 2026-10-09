"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LiveKitRoom,
  PreJoin,
  VideoConference,
  useRemoteParticipants,
  type LocalUserChoices,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { DisconnectReason } from "livekit-client";
import MeetingLimits from "@/components/MeetingLimits";
import { VISITOR_PREFIX } from "@/lib/screenProtocol";

// The /join page (#22): a team member the receptionist called joins the
// visitor's video call from the link in her email (agent-worker/staff_call.py).
// The call has its own private room; the kiosk shows it full screen
// (StaffCallModal). The link's fragment (#t=<token>&u=<url>) never reaches a
// server log; the page hands the token to /api/livekit/call-status, which
// checks it and that the call room is still open with the visitor in it.
// Then, like the public meeting room: LiveKit's PreJoin (camera preview,
// mic/camera toggles, Join) and VideoConference (both tiles, mic, camera,
// Leave). Leaving, on either side, ends the call for both: the room is
// deleted (/api/livekit/call-end).

type Phase = "checking" | "prejoin" | "live" | "left" | "gone" | "expired" | "invalid" | "error";

type CallStatus = {
  url: string;
  room: string;
  name: string;
  visitor: string;
  visitorHere: boolean;
};

export default function StaffJoin() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [call, setCall] = useState<CallStatus | null>(null);
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [error, setError] = useState("");
  const tokenRef = useRef("");
  const endedRef = useRef(false); // the call is over for this page, whatever LiveKit reports next

  // 1. Is the link good, and is the visitor still there?
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get("t") ?? "";
    const linkUrl = params.get("u") ?? "";
    tokenRef.current = token;
    if (!token) {
      setPhase("invalid");
      return;
    }
    (async () => {
      try {
        const res = await fetch("/api/livekit/call-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 401) {
          setPhase(body.error === "expired" ? "expired" : "invalid");
          return;
        }
        if (!res.ok) throw new Error(body.error || `status ${res.status}`);
        // The site's own LiveKit server, never one a link names.
        if (linkUrl && linkUrl !== body.url) console.warn("[join] the link names another LiveKit server; ignored");
        setCall(body);
        setPhase(body.visitorHere ? "prejoin" : "gone");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, []);

  // 2. The call is over for us: say why, and delete the call room so the
  // kiosk's window closes too (already gone is fine).
  const end = useCallback((next: Phase, why: string) => {
    if (endedRef.current) return;
    endedRef.current = true;
    console.log("[join] call over:", why);
    setPhase(next);
    fetch("/api/livekit/call-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tokenRef.current }),
      keepalive: true,
    }).catch(() => {});
  }, []);
  const visitorGone = useCallback(() => end("gone", "the visitor left"), [end]);

  const visitor = call?.visitor || "A visitor";
  const first = (call?.name ?? "").split(/\s+/)[0];

  if (phase === "prejoin" && call) {
    return (
      <div
        data-lk-theme="default"
        className="staff-join"
        style={{ ...page, alignItems: "center", gap: 12, padding: "20px 16px max(16px, env(safe-area-inset-bottom))" }}
      >
        <div style={{ textAlign: "center" }}>
          <div role="status" style={{ fontSize: 22, fontWeight: 800 }}>
            {visitor} is at the kiosk
          </div>
          <div style={{ fontSize: 15, opacity: 0.85, marginTop: 6, lineHeight: 1.4, maxWidth: 420 }}>
            {first ? `${first}, j` : "J"}oin the video call: you&apos;ll see and hear each other.
          </div>
        </div>
        <PreJoin
          onSubmit={(c) => {
            endedRef.current = false;
            setChoices(c);
            setPhase("live");
          }}
          onError={(e) => setError(e.message)}
          onValidate={() => true}
          joinLabel="Join the call"
          persistUserChoices={false}
          defaults={{ username: call.name, videoEnabled: true, audioEnabled: true }}
        />
        {error && <div style={{ color: "#fca5a5", textAlign: "center", fontSize: 14 }}>{error}</div>}
        {/* Their name comes from the link: no name field to fill in. */}
        {/* flex: none, or the page's column squeezes it. On a phone the mic and
            camera groups wrap onto two rows but keep a one-row height, so the
            camera row ran under Join: let them size to their content. */}
        <style>{`.staff-join .lk-prejoin { flex: none; width: min(100%, 420px); padding: 0; }
.staff-join .lk-prejoin #username { display: none; }
.staff-join .lk-prejoin .lk-button-group-container { height: auto; }
.staff-join .lk-prejoin .lk-button-group-container > .lk-button-group { flex: 1 1 100%; height: auto; }`}</style>
      </div>
    );
  }

  if (phase === "live" && call && choices) {
    return (
      <div style={page} data-staff-call="live">
        <LiveKitRoom
          data-lk-theme="default"
          serverUrl={call.url}
          token={tokenRef.current}
          connect
          video={choices.videoEnabled ? { deviceId: choices.videoDeviceId || undefined } : false}
          audio={choices.audioEnabled ? { deviceId: choices.audioDeviceId || undefined } : false}
          onDisconnected={(reason) => {
            if (reason === DisconnectReason.CLIENT_INITIATED) end("left", "left");
            else if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.PARTICIPANT_REMOVED)
              end("gone", `room ended (${reason})`);
            else if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
              setError("You joined this call from another device.");
              end("error", "joined elsewhere");
            } else {
              setError("The connection dropped.");
              end("error", `disconnected (${reason})`);
            }
          }}
          onError={(e) => {
            // A camera or mic that fails leaves the call on what works.
            console.warn("[join] LiveKit error:", e);
            if (/full/i.test(e.message)) {
              setError("Someone else has already joined this call.");
              end("error", "room full");
            }
          }}
          style={{ height: "100%", position: "relative" }}
        >
          <VideoConference />
          <VisitorWatch onGone={visitorGone} />
          <MeetingLimits />
        </LiveKitRoom>
        {/* No chat: the call token carries no data permission. */}
        <style>{`[data-staff-call] .lk-chat-toggle { display: none; }`}</style>
      </div>
    );
  }

  return (
    <div style={{ ...page, alignItems: "center", justifyContent: "center", gap: 12, padding: "16px 20px" }}>
      <Message phase={phase} error={error} />
    </div>
  );
}

// In the call: the kiosk leaving (or never there: it left between the check
// and the join) ends it.
function VisitorWatch({ onGone }: { onGone: () => void }) {
  const remotes = useRemoteParticipants();
  const visitorHere = remotes.some((p) => p.identity.startsWith(VISITOR_PREFIX));
  const seenRef = useRef(false);
  useEffect(() => {
    if (visitorHere) {
      seenRef.current = true;
      return;
    }
    // Before the first participant list arrives `remotes` is empty too: give
    // the connection a moment before deciding nobody is there.
    const t = setTimeout(onGone, seenRef.current ? 0 : 8000);
    return () => clearTimeout(t);
  }, [visitorHere, onGone]);
  return null;
}

function Message({ phase, error }: { phase: Phase; error: string }) {
  const text: Record<Exclude<Phase, "live" | "prejoin">, [string, string]> = {
    checking: ["Checking the call…", ""],
    left: ["You left the call", "The call has ended for the visitor too."],
    gone: ["The visitor has left", "The call is over: there's nothing more to do."],
    expired: ["This call link has expired", "Links work for 15 minutes. The visitor may have left a message for you instead."],
    invalid: ["This link doesn't work", "Open the link from the email again, without changing it."],
    error: ["Something went wrong", error || "Try again in a moment."],
  };
  const [title, sub] = text[phase as keyof typeof text];
  return (
    <>
      <div role="status" style={{ fontSize: 24, fontWeight: 800, textAlign: "center" }}>
        {title}
      </div>
      {sub && <div style={{ fontSize: 16, opacity: 0.85, textAlign: "center", maxWidth: 420, lineHeight: 1.4 }}>{sub}</div>}
      {phase === "error" && (
        <button onClick={() => window.location.reload()} style={retryButton}>
          Try again
        </button>
      )}
    </>
  );
}

const page: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  background: "#0b1020",
  color: "white",
  fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  userSelect: "text",
  overflow: "auto",
};

const retryButton: React.CSSProperties = {
  minHeight: 52,
  padding: "0 26px",
  borderRadius: 999,
  border: "none",
  background: "#0070f3",
  color: "white",
  fontSize: 17,
  fontWeight: 800,
};
