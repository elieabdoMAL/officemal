"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  createLocalTracks,
  type LocalTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import { ASSISTANT_NAME } from "@/lib/assistant";
import { VISITOR_PREFIX, isStaff } from "@/lib/screenProtocol";

// The /join page (#22): a team member the receptionist called joins the
// kiosk's conversation by video, from the link in her email
// (agent-worker/staff_call.py). The link's fragment (#t=<token>&u=<url>) never
// reaches a server log; the page hands the token to /api/livekit/call-status,
// which checks it and that the visitor is still there, then shows a camera
// preview and a Join button. In the call: the kiosk's picture (her; the
// kiosk has no camera) and sound, their own picture small, mute buttons and
// Leave. She stays quiet while they're in, and takes the visitor back when
// they leave. The visitor leaving ends the room: the page says so.

type Phase = "checking" | "preview" | "joining" | "live" | "left" | "gone" | "expired" | "invalid" | "error";

type CallStatus = {
  url: string;
  room: string;
  name: string;
  visitor: string;
  visitorHere: boolean;
};

const hasVisitor = (room: Room) =>
  [...room.remoteParticipants.values()].some((p) => p.identity.startsWith(VISITOR_PREFIX));

export default function StaffJoin() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [call, setCall] = useState<CallStatus | null>(null);
  const [error, setError] = useState("");
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [hasCamera, setHasCamera] = useState(false);
  const [ready, setReady] = useState(false); // camera and mic asked for
  const [kioskVideo, setKioskVideo] = useState(false);

  const tokenRef = useRef("");
  const tracksRef = useRef<LocalTrack[]>([]);
  const roomRef = useRef<Room | null>(null);
  const leavingRef = useRef(false); // we hung up, as opposed to the room ending
  const selfRef = useRef<HTMLVideoElement | null>(null);
  const kioskRef = useRef<HTMLVideoElement | null>(null);
  const audioBoxRef = useRef<HTMLDivElement | null>(null);

  const stopTracks = useCallback(() => {
    tracksRef.current.forEach((t) => t.stop());
    tracksRef.current = [];
  }, []);

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
        setPhase(body.visitorHere ? "preview" : "gone");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, []);

  // 2. Camera and mic for the preview (kept for the call). No camera, or it
  // was refused: the mic alone.
  useEffect(() => {
    if (phase !== "preview" || tracksRef.current.length) return;
    let cancelled = false;
    (async () => {
      let tracks: LocalTrack[] = [];
      try {
        tracks = await createLocalTracks({ audio: true, video: { facingMode: "user" } });
      } catch (e) {
        console.warn("[join] camera + mic failed, trying the mic alone:", e);
        try {
          tracks = await createLocalTracks({ audio: true });
        } catch (e2) {
          if (!cancelled) setError("Allow the microphone (and camera) for this page, then reload it.");
          console.warn("[join] mic failed too:", e2);
        }
      }
      if (cancelled) {
        tracks.forEach((t) => t.stop());
        return;
      }
      tracksRef.current = tracks;
      const video = tracks.find((t) => t.kind === Track.Kind.Video);
      setHasCamera(!!video);
      setCamOn(!!video);
      setReady(true);
      if (video && selfRef.current) video.attach(selfRef.current);
    })();
    return () => {
      cancelled = true;
    };
  }, [phase]);

  const leaveRoom = useCallback(async (next: Phase) => {
    leavingRef.current = true;
    setPhase(next);
    await roomRef.current?.disconnect().catch(() => {});
    roomRef.current = null;
    stopTracks();
  }, [stopTracks]);

  // 3. Join: the kiosk's sound and picture in, their camera and mic out.
  const join = useCallback(async () => {
    if (!call) return;
    setPhase("joining");
    setError("");
    leavingRef.current = false;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        audioBoxRef.current?.appendChild(el);
      } else if (track.kind === Track.Kind.Video && !isStaff(p.identity) && kioskRef.current) {
        track.attach(kioskRef.current);
        setKioskVideo(true);
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      track.detach().forEach((el) => {
        if (el instanceof HTMLAudioElement) el.remove();
      });
      if (track.kind === Track.Kind.Video) setKioskVideo(false);
    });
    room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      if (p.identity.startsWith(VISITOR_PREFIX)) void leaveRoom("gone");
    });
    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      stopTracks();
      if (leavingRef.current) return;
      console.log("[join] disconnected:", reason);
      if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
        setError("You joined this call from another device.");
        setPhase("error");
      } else if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.PARTICIPANT_REMOVED) {
        setPhase("gone");
      } else {
        setError("The connection dropped.");
        setPhase("error");
      }
    });

    try {
      await room.connect(call.url, tokenRef.current);
      if (!hasVisitor(room)) {
        await leaveRoom("gone"); // left between the check and now
        return;
      }
      for (const t of tracksRef.current) await room.localParticipant.publishTrack(t);
      await room.startAudio().catch(() => {});
      console.log("[join] live in", room.name);
      setPhase("live");
    } catch (e) {
      console.warn("[join] could not join:", e);
      leavingRef.current = true;
      await room.disconnect().catch(() => {});
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [call, leaveRoom, stopTracks]);

  // Hang up when the page goes away.
  useEffect(() => {
    const bye = () => {
      leavingRef.current = true;
      roomRef.current?.disconnect();
    };
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      bye();
      stopTracks();
    };
  }, [stopTracks]);

  const toggleMic = () => {
    const mic = tracksRef.current.find((t) => t.kind === Track.Kind.Audio);
    if (!mic) return;
    void (micOn ? mic.mute() : mic.unmute());
    setMicOn(!micOn);
  };
  const toggleCam = () => {
    const cam = tracksRef.current.find((t) => t.kind === Track.Kind.Video);
    if (!cam) return;
    void (camOn ? cam.mute() : cam.unmute());
    setCamOn(!camOn);
  };

  const visitor = call?.visitor || "A visitor";
  const inCall = phase === "live" || phase === "joining";
  const showSelf = (phase === "preview" || inCall) && hasCamera;

  return (
    <div style={page}>
      <div ref={audioBoxRef} style={{ display: "none" }} />

      {inCall && (
        <div style={{ flex: 1, position: "relative", background: "#000", minHeight: 0 }}>
          <video ref={kioskRef} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          {!kioskVideo && <div style={{ ...centered, position: "absolute", inset: 0 }}>Connecting to the kiosk…</div>}
          <div style={topBar}>
            <div style={{ fontWeight: 800 }}>
              <span style={dot} />
              {phase === "live" ? `Live with ${visitor} at the kiosk` : "Joining…"}
            </div>
            <div style={{ opacity: 0.8, fontSize: 13, marginTop: 2 }}>
              They see and hear you. The kiosk has no camera: you see {ASSISTANT_NAME} and hear the lobby.
            </div>
          </div>
        </div>
      )}

      {!inCall && (
        <div style={{ ...centered, flex: 1, flexDirection: "column", gap: 14, padding: "24px 20px" }}>
          <Message phase={phase} visitor={visitor} name={call?.name ?? ""} error={error} />
        </div>
      )}

      <video
        ref={selfRef}
        autoPlay
        playsInline
        muted
        data-self-view
        style={{
          ...(inCall ? selfPip : selfPreview),
          display: showSelf ? "block" : "none",
          visibility: camOn ? "visible" : "hidden",
        }}
      />

      {(phase === "preview" || inCall) && (
        <div style={controls}>
          <button onClick={toggleMic} style={roundButton(micOn)} aria-pressed={!micOn}>
            {micOn ? "Mic on" : "Mic off"}
          </button>
          {hasCamera && (
            <button onClick={toggleCam} style={roundButton(camOn)} aria-pressed={!camOn}>
              {camOn ? "Camera on" : "Camera off"}
            </button>
          )}
          {phase === "preview" ? (
            <button onClick={join} disabled={!ready} style={bigButton("#16a34a")}>
              Join the call
            </button>
          ) : (
            <button onClick={() => void leaveRoom("left")} style={bigButton("#dc2626")}>
              Leave
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Message({ phase, visitor, name, error }: { phase: Phase; visitor: string; name: string; error: string }) {
  const first = name.split(/\s+/)[0];
  const text: Record<Exclude<Phase, "live" | "joining">, [string, string]> = {
    checking: ["Checking the call…", ""],
    preview: [
      `${visitor} is at the kiosk`,
      `${first ? `${first}, j` : "J"}oin the video call: they'll see and hear you. ${ASSISTANT_NAME} stays quiet while you're on, and takes over again when you leave.`,
    ],
    left: ["You left the call", `${ASSISTANT_NAME} is taking it from here.`],
    gone: ["The visitor has left", "The kiosk conversation is over: there's nothing more to do."],
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
      {phase === "preview" && error && <div style={{ color: "#fca5a5", textAlign: "center" }}>{error}</div>}
      {phase === "error" && (
        <button onClick={() => window.location.reload()} style={bigButton("#0070f3")}>
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

const centered: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", color: "white" };

const topBar: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  top: 0,
  padding: "max(12px, env(safe-area-inset-top)) 16px 24px",
  background: "linear-gradient(rgba(0,0,0,0.7), transparent)",
  fontSize: 16,
};

const dot: React.CSSProperties = {
  display: "inline-block",
  width: 10,
  height: 10,
  borderRadius: "50%",
  background: "#22c55e",
  marginRight: 8,
};

const selfPreview: React.CSSProperties = {
  alignSelf: "center",
  width: "min(88vw, 360px)",
  aspectRatio: "3 / 4",
  objectFit: "cover",
  borderRadius: 16,
  transform: "scaleX(-1)", // a mirror, as people expect of their own face
  background: "#1e293b",
  margin: "0 0 12px",
};

const selfPip: React.CSSProperties = {
  position: "absolute",
  right: 12,
  bottom: "calc(96px + env(safe-area-inset-bottom))",
  width: "min(28vw, 140px)",
  aspectRatio: "3 / 4",
  objectFit: "cover",
  borderRadius: 12,
  border: "2px solid rgba(255,255,255,0.8)",
  transform: "scaleX(-1)",
  background: "#1e293b",
};

const controls: React.CSSProperties = {
  display: "flex",
  gap: 10,
  justifyContent: "center",
  alignItems: "center",
  flexWrap: "wrap",
  padding: "14px 16px max(16px, env(safe-area-inset-bottom))",
  background: "#0b1020",
};

function roundButton(on: boolean): React.CSSProperties {
  return {
    minHeight: 48,
    padding: "0 16px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.35)",
    background: on ? "rgba(255,255,255,0.12)" : "#f8fafc",
    color: on ? "white" : "#0b1020",
    fontSize: 15,
    fontWeight: 600,
  };
}

function bigButton(color: string): React.CSSProperties {
  return {
    minHeight: 52,
    padding: "0 26px",
    borderRadius: 999,
    border: "none",
    background: color,
    color: "white",
    fontSize: 17,
    fontWeight: 800,
  };
}
