"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LiveKitRoom,
  VideoConference,
  useRemoteParticipants,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { DisconnectReason, MediaDeviceFailure } from "livekit-client";
import MeetingLimits from "@/components/MeetingLimits";
import { asLang, pick, type Lang } from "@/lib/assistant";
import { isStaff, type CallClosedMessage, type CallOpenMessage } from "@/lib/screenProtocol";
import { postToEmbed } from "@/lib/tour";

// The kiosk's video call with a team member (#22), full screen on the top
// page, same look as the Public Meeting Room pop-up (PublicMeetingModal).
//
// The receptionist embed forwards the worker's "call_open" here as
// "receptionist-call" (docs/screen-protocol.md, sections 5 and 8): the call's
// own LiveKit room and the kiosk's token for it. The window opens at once and
// joins with camera (if the kiosk has one) and mic, showing "Calling Nicolas…"
// and a Cancel button until they join; the embed mutes its mic meanwhile.
//   - They join: LiveKit's VideoConference, both tiles. Her session ends
//     (the worker deletes the kiosk room, the AI button hides her).
//   - Either side leaves, or ✕: the window closes and the call room is
//     deleted (/api/livekit/call-end), which ends it on the phone too.
//   - Unanswered (the worker deletes the room, or sends "call_close"), or
//     Cancel: the window closes; the embed tells her, she offers a message.

type Call = { url: string; token: string; to: string; lang: Lang | null };

const TEXT = {
  title: (first: string) => ({ fr: `Appel avec ${first}`, en: `Call with ${first}` }),
  calling: (first: string) => ({ fr: `Appel à ${first}…`, en: `Calling ${first}…` }),
  hint: (first: string) => ({
    fr: `${first} apparaîtra ici dès que l'appel sera accepté.`,
    en: `${first} will appear here as soon as the call is answered.`,
  }),
  cancel: { fr: "Annuler", en: "Cancel" },
  close: { fr: "Quitter l'appel", en: "Leave the call" },
};

// A message from the embed: same origin only, it carries a join token.
function asCall(data: unknown): Call | null {
  const m = data as Partial<CallOpenMessage> | null;
  if (m?.type !== "receptionist-call") return null;
  if (typeof m.url !== "string" || !/^wss?:\/\//.test(m.url) || typeof m.token !== "string" || !m.token) return null;
  const to = typeof m.to === "string" && m.to.trim() ? m.to.trim().slice(0, 80) : "";
  return { url: m.url, token: m.token, to, lang: asLang(m.lang) };
}

// A camera that fails (none, refused, busy) leaves the call on the mic alone.
function isMediaError(e: Error): boolean {
  return (
    MediaDeviceFailure.getFailure(e) !== undefined ||
    ["NotAllowedError", "NotFoundError", "NotReadableError", "OverconstrainedError", "AbortError"].includes(e.name)
  );
}

export default function StaffCallModal({ topOnly = false }: { topOnly?: boolean }) {
  const [call, setCall] = useState<Call | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  // Whether to ask for the camera: only if the kiosk has one.
  const [camera, setCamera] = useState<boolean | null>(null);
  const [answered, setAnswered] = useState(false);
  const callRef = useRef<Call | null>(null);
  callRef.current = call;
  const answeredRef = useRef(false);
  answeredRef.current = answered;

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Close the window, delete the call room (whoever is still in it is
  // disconnected: the phone says the call is over) and tell the embed.
  // byVisitor: Cancel, ✕ or Leave, rather than the call ending on its own.
  const close = useCallback((byVisitor: boolean, why: string) => {
    const current = callRef.current;
    if (!current) return;
    console.log("[call] closing:", why);
    callRef.current = null;
    setCall(null);
    setCamera(null);
    fetch("/api/livekit/call-end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: current.token }),
      keepalive: true,
    }).catch((e) => console.warn("[call] call-end failed:", e));
    const closed: CallClosedMessage = { type: "call-closed", answered: answeredRef.current, byVisitor };
    postToEmbed([closed]);
  }, []);

  useEffect(() => {
    // On the embed page itself, only when it is the whole page (tests): in
    // the tour, the top page's own instance is the one.
    if (topOnly && window.top !== window) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const type = (e.data as { type?: string })?.type;
      if (type === "receptionist-call") {
        const next = asCall(e.data);
        if (!next) return console.warn("[call] ignored a malformed call message");
        if (callRef.current) return console.warn("[call] a call is already open");
        console.log("[call] opening the call with", next.to);
        setAnswered(false);
        setCall(next);
      } else if (type === "receptionist-call-close") {
        close(false, "the worker closed it");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [topOnly, close]);

  // The camera, if there is one; asking for a camera the kiosk doesn't have
  // only produces an error. Mic either way.
  useEffect(() => {
    if (!call || camera !== null) return;
    let gone = false;
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((devices) => !gone && setCamera(devices.some((d) => d.kind === "videoinput")))
      .catch(() => !gone && setCamera(true));
    if (!navigator.mediaDevices) setCamera(false);
    return () => {
      gone = true;
    };
  }, [call, camera]);

  const onAnswered = useCallback(() => {
    console.log("[call] answered");
    setAnswered(true);
    postToEmbed([{ type: "call-answered" }]);
  }, []);

  if (!call) return null;

  const first = call.to.split(/\s+/)[0] || call.to;
  const title = first ? pick(call.lang, TEXT.title(first)).join(" · ") : "";

  return (
    <div
      data-call-modal={answered ? "live" : "ringing"}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(255, 255, 255, 0.1)",
        backdropFilter: "blur(12px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2100,
        pointerEvents: "auto",
      }}
    >
      {/* No click-outside-to-close: a stray tap on the backdrop would drop
          the visitor out of the call. Only ✕, Cancel and Leave close it. */}
      <div
        style={{
          position: "relative",
          width: isMobile ? "98vw" : "85vw",
          height: isMobile ? "92vh" : "80vh",
          maxWidth: "1200px",
          background: "rgba(0, 0, 0, 0.55)",
          backdropFilter: "blur(20px)",
          borderRadius: "20px",
          border: "1px solid rgba(255, 255, 255, 0.2)",
          boxShadow: "0 25px 50px rgba(0, 0, 0, 0.3)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: isMobile ? "12px 16px" : "14px 20px",
            borderBottom: "1px solid rgba(255, 255, 255, 0.15)",
            flexShrink: 0,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: isMobile ? "16px" : "20px",
              fontWeight: "600",
              color: "white",
              fontFamily: "sans-serif",
              textShadow: "0 2px 10px rgba(0, 0, 0, 0.3)",
            }}
          >
            {title}
          </h2>

          <button
            onClick={() => close(true, "✕")}
            style={{
              background: "rgba(255, 255, 255, 0.2)",
              border: "none",
              borderRadius: "50%",
              width: isMobile ? "36px" : "40px",
              height: isMobile ? "36px" : "40px",
              cursor: "pointer",
              fontSize: isMobile ? "16px" : "18px",
              color: "white",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title={pick(call.lang, TEXT.close).join(" / ")}
            aria-label={pick(call.lang, TEXT.close).join(" / ")}
          >
            ✕
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          {camera !== null && (
            <LiveKitRoom
              data-lk-theme="default"
              serverUrl={call.url}
              token={call.token}
              connect
              video={camera}
              audio
              onDisconnected={(reason) =>
                // Leave in the control bar is the visitor's own; anything else
                // (the room deleted, the network) ended the call.
                close(reason === DisconnectReason.CLIENT_INITIATED, `disconnected (${reason})`)
              }
              onMediaDeviceFailure={(failure, kind) => console.warn("[call] media device failure:", kind, failure)}
              onError={(e) => {
                if (isMediaError(e)) {
                  console.warn("[call] camera or mic unavailable, going on without it:", e.message);
                  return;
                }
                // Couldn't get into the call room: as if the visitor cancelled,
                // so she takes them back and offers a message.
                console.warn("[call] could not join the call:", e);
                close(true, `error: ${e.message}`);
              }}
              style={{ height: "100%", position: "relative" }}
            >
              <VideoConference />
              <CallProgress
                first={first}
                lang={call.lang}
                answered={answered}
                onAnswered={onAnswered}
                onStaffLeft={() => close(false, "they left")}
                onCancel={() => close(true, "Cancel")}
              />
              <MeetingLimits />
            </LiveKitRoom>
          )}
        </div>
        {/* No chat: the call tokens carry no data permission (and a kiosk has
            no keyboard). VideoConference shows the toggle regardless. */}
        <style>{`[data-call-modal] .lk-chat-toggle { display: none; }`}</style>
      </div>
    </div>
  );
}

// Inside the call room: who is there. Until the person called joins, a
// "Calling …" panel with Cancel floats over the visitor's own picture; once
// they have joined, their leaving ends the call.
function CallProgress({
  first,
  lang,
  answered,
  onAnswered,
  onStaffLeft,
  onCancel,
}: {
  first: string;
  lang: Lang | null;
  answered: boolean;
  onAnswered: () => void;
  onStaffLeft: () => void;
  onCancel: () => void;
}) {
  const staffHere = useRemoteParticipants().some((p) => isStaff(p.identity));

  useEffect(() => {
    if (staffHere && !answered) onAnswered();
    else if (!staffHere && answered) onStaffLeft();
  }, [staffHere, answered, onAnswered, onStaffLeft]);

  if (answered || staffHere) return null;
  return (
    <div style={ringingBox} role="status" data-call-ringing>
      <div aria-hidden style={ringIcon}>
        ☎
      </div>
      <div style={{ minWidth: 0 }}>
        {pick(lang, TEXT.calling(first)).map((t, i) => (
          <div key={t} style={{ fontWeight: 800, fontSize: i ? 16 : 20 }}>
            {t}
          </div>
        ))}
        <div style={{ opacity: 0.85, fontSize: 14, marginTop: 4 }}>{pick(lang, TEXT.hint(first)).join(" ")}</div>
      </div>
      <button type="button" className="lk-button" onClick={onCancel} style={cancelButton}>
        {pick(lang, TEXT.cancel).join(" / ")}
      </button>
      <style>{`@keyframes call-ring { 0% { box-shadow: 0 0 0 0 rgba(0,112,243,0.6); } 100% { box-shadow: 0 0 0 18px rgba(0,112,243,0); } }`}</style>
    </div>
  );
}

const ringingBox: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: "50%",
  transform: "translateX(-50%)",
  width: "min(560px, calc(100% - 24px))",
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "14px 16px",
  borderRadius: 16,
  background: "rgba(15, 23, 42, 0.92)",
  border: "1px solid rgba(255, 255, 255, 0.25)",
  boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
  color: "white",
  fontFamily: "sans-serif",
  zIndex: 10,
};

const ringIcon: React.CSSProperties = {
  flex: "none",
  width: 44,
  height: 44,
  borderRadius: "50%",
  background: "#0070f3",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 22,
  animation: "call-ring 1.4s ease-out infinite",
};

const cancelButton: React.CSSProperties = {
  flex: "none",
  marginLeft: "auto",
  background: "#dc2626",
  color: "white",
  fontWeight: 700,
};
