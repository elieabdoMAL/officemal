"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useRemoteParticipants, useRoomContext } from "@livekit/components-react";
import { devTimeout } from "@/lib/devTimeout";

// Ends a public-meeting connection nobody is using: after a while alone, or at
// a hard cap on length. The room only closes once it's empty, so a guest who
// walks away — or a kiosk left with the pop-up open — would otherwise keep it
// open (and billing LiveKit minutes) forever.
// Leaving here is room.disconnect(), the same path as the Leave button, so the
// pop-up closes and /meet shows "You left the meeting".
//
//   ALONE_TIMEOUT_MS — nobody else here this long: probably waiting for no one.
//                      Long enough to wait for someone running a few minutes late.
//   ALONE_WARNING_MS — then a countdown with a "Stay" button, so someone still
//                      at the screen isn't dropped without a chance to say so.
//   MAX_CONNECTION_MS — hard cap per connection, alone or not: a lobby meeting
//                       runs well under this, so hitting it means two forgotten
//                       screens keeping each other company.
//   MAX_WARNING_MS    — heads-up before the cap, time to wrap up. Rejoining
//                       starts a fresh connection.
const ALONE_TIMEOUT_MS = 5 * 60_000;
const ALONE_WARNING_MS = 30_000;
const MAX_CONNECTION_MS = 2 * 60 * 60_000;
const MAX_WARNING_MS = 5 * 60_000;

export default function MeetingLimits() {
  const room = useRoomContext();
  // Before the connection completes this is also empty, which only starts the
  // alone clock a moment early.
  const remotes = useRemoteParticipants();
  const alone = remotes.length === 0;

  // When the alone countdown ends (null = no warning showing).
  const [aloneLeaveAt, setAloneLeaveAt] = useState<number | null>(null);
  // Bumped by "Stay" to restart the alone clock from zero.
  const [stays, setStays] = useState(0);
  // Re-render clock for the countdown text.
  const [now, setNow] = useState(() => Date.now());

  // Alone clock: runs only while nobody else is here, so someone joining
  // cancels it — and the warning, if it's already showing.
  useEffect(() => {
    if (!alone) return;
    const t = setTimeout(() => {
      setNow(Date.now());
      setAloneLeaveAt(Date.now() + devTimeout("aloneWarnMs", ALONE_WARNING_MS));
    }, devTimeout("aloneMs", ALONE_TIMEOUT_MS));
    return () => {
      clearTimeout(t);
      setAloneLeaveAt(null);
    };
  }, [alone, stays]);

  useEffect(() => {
    if (aloneLeaveAt === null) return;
    const t = setTimeout(() => room.disconnect(), Math.max(0, aloneLeaveAt - Date.now()));
    return () => clearTimeout(t);
  }, [aloneLeaveAt, room]);

  // When the connection hits its cap (null = no warning yet), and whether the
  // guest has closed the heads-up. Closing it doesn't postpone the end.
  const [maxEndAt, setMaxEndAt] = useState<number | null>(null);
  const [maxDismissed, setMaxDismissed] = useState(false);

  // Max length: one clock per connection — this component mounts with the
  // LiveKitRoom, so a reconnect blip doesn't reset it, but Rejoin does.
  useEffect(() => {
    const maxMs = devTimeout("maxMs", MAX_CONNECTION_MS);
    const warnMs = Math.min(devTimeout("maxWarnMs", MAX_WARNING_MS), maxMs);
    const endAt = Date.now() + maxMs;
    const warn = setTimeout(() => {
      setNow(Date.now());
      setMaxEndAt(endAt);
    }, maxMs - warnMs);
    const end = setTimeout(() => room.disconnect(), maxMs);
    return () => {
      clearTimeout(warn);
      clearTimeout(end);
    };
  }, [room]);

  const showMax = maxEndAt !== null && !maxDismissed;
  const counting = aloneLeaveAt !== null || showMax;
  useEffect(() => {
    if (!counting) return;
    const i = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(i);
  }, [counting]);

  if (!counting) return null;

  return (
    <div style={stackStyle}>
      {aloneLeaveAt !== null && (
        <div role="alertdialog" aria-live="assertive" data-testid="alone-warning" style={bannerStyle}>
          <span>
            You&apos;re alone in the meeting — leaving in {secondsUntil(aloneLeaveAt, now)} s
          </span>
          <button
            type="button"
            className="lk-button"
            onClick={() => setStays((n) => n + 1)}
            style={buttonStyle}
          >
            Stay
          </button>
        </div>
      )}
      {showMax && (
        <div role="status" aria-live="polite" data-testid="max-length-warning" style={bannerStyle}>
          <span>This meeting will end for you in {timeLeft(secondsUntil(maxEndAt, now))}</span>
          <button
            type="button"
            className="lk-button"
            onClick={() => setMaxDismissed(true)}
            style={buttonStyle}
          >
            OK
          </button>
        </div>
      )}
    </div>
  );
}

function secondsUntil(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000));
}

// "5 minutes" … "2 minutes", then seconds for the last minute.
function timeLeft(seconds: number): string {
  if (seconds <= 60) return `${seconds} s`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

// Floats over the top of VideoConference; the stack itself lets clicks through
// to the call controls underneath.
const stackStyle: CSSProperties = {
  position: "absolute",
  top: 12,
  left: 0,
  right: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 8,
  padding: "0 12px",
  zIndex: 10,
  pointerEvents: "none",
};

const bannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  maxWidth: "100%",
  padding: "10px 12px 10px 16px",
  borderRadius: 12,
  background: "rgba(20, 20, 20, 0.92)",
  border: "1px solid rgba(255, 255, 255, 0.25)",
  boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
  color: "white",
  fontFamily: "sans-serif",
  fontSize: 15,
  pointerEvents: "auto",
};

const buttonStyle: CSSProperties = {
  flexShrink: 0,
  background: "#0070f3",
  color: "white",
};
