// The kiosk screen's side of docs/screen-protocol.md: what the worker can tell
// the screen (her state, her language, cards to show) and what the screen can
// tell the worker (the visitor tapped). Keep the two in step.

import type { Lang } from "@/lib/assistant";

// Participant attributes the worker sets on itself.
export const ATTR_STATE = "mia.state";
export const ATTR_LANGUAGE = "mia.language";

// "listening": in a conversation (the default when the attribute is missing).
// "paused": she was told to stop talking and waits for her name (#24, #25).
// Anything else is shown as "listening".
export type MiaState = "listening" | "paused";

export function asMiaState(v: unknown): MiaState {
  return v === "paused" ? v : "listening";
}

// A video call to staff (#22) has its own room, "call-<uuid>": the kiosk joins
// it as "visitor-<…>" (as in its own room, /api/livekit/token), the team
// member she called as "staff-<team.json id>", named with their display name.
export const STAFF_PREFIX = "staff-";
export const VISITOR_PREFIX = "visitor-";
export const CALL_ROOM_PREFIX = "call-";

export function isStaff(identity: string): boolean {
  return identity.startsWith(STAFF_PREFIX);
}

// Text-stream topics. lk.transcription is LiveKit's own (AgentSession publishes
// both sides of the conversation on it).
export const TOPIC_TRANSCRIPTION = "lk.transcription";
export const TOPIC_SCREEN = "mia.screen"; // worker -> screen, JSON ScreenMessage
export const TOPIC_CONTROL = "mia.control"; // screen -> worker, JSON ControlMessage

export const ATTR_TRANSCRIPTION_FINAL = "lk.transcription_final";
export const ATTR_SEGMENT_ID = "lk.segment_id";

export type SentKind = "message" | "notify" | "alert" | "suggestion" | "project_request" | "meeting";

// The on-screen buttons Mia can press herself (#2, the worker's press_button
// tool — keep PRESSABLE_BUTTONS in agent-worker/worker.py in step):
//   contact        the Contact button on her frame (opens the contact card)
//   mute / unmute  the kiosk's sound button (muting also suspends her)
//   vr             the VR button (entering VR hides her video)
//   recenter       recenter the panorama view
//   meeting_room   the private Meeting Room pop-up
//   public_meeting the Public Meeting Room pop-up
// "contact" is handled inside the embed; the rest are forwarded to the top
// page as a "receptionist-press" window message (section 5 of the protocol).
export const PRESS_BUTTONS = [
  "contact",
  "mute",
  "unmute",
  "vr",
  "recenter",
  "meeting_room",
  "public_meeting",
] as const;
export type PressButton = (typeof PRESS_BUTTONS)[number];

// The project request form (#20), field key -> value, in the order the worker
// sent them (its PROJECT_FIELDS, agent-worker/leads.py). Empty = not given.
export type ProjectFields = [key: string, value: string][];
export type ProjectStatus = "draft" | "sent";

export type ScreenMessage =
  | { type: "contact_card"; lang?: Lang }
  | { type: "message_sent"; kind?: SentKind; to?: string; lang?: Lang }
  | { type: "project_request"; status: ProjectStatus; fields: ProjectFields; lang?: Lang }
  | { type: "directions"; address: string; maps_url: string; lang?: Lang }
  | { type: "recording"; status: RecordingStatus; lang?: Lang }
  | { type: "press"; button: PressButton }
  | { type: "call_open"; url: string; token: string; to?: string; lang?: Lang }
  | { type: "call_close" }
  | { type: "call_answered" }
  | { type: "dismiss" };

// A voice message is being recorded (#5, round 2): "on" shows the red
// "● Recording — say 'done' when finished" card while the visitor dictates,
// "off" removes it (the worker's record_voice_message).
export type RecordingStatus = "on" | "off";

const SENT_KINDS: SentKind[] = ["message", "notify", "alert", "suggestion", "project_request", "meeting"];

// Visitor-dictated text: keep the card's size sane whatever arrives.
const MAX_PROJECT_FIELDS = 12;
const MAX_PROJECT_VALUE = 600;

function parseProjectFields(raw: unknown): ProjectFields | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string" || v == null)
    .slice(0, MAX_PROJECT_FIELDS)
    .map(([k, v]) => [k.slice(0, 40), ((v as string | null) ?? "").trim().slice(0, MAX_PROJECT_VALUE)]);
}

function displayName(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : undefined;
}

// Unknown or malformed messages come back null and are ignored, so the worker
// can start sending a new type before the screen knows how to draw it.
export function parseScreenMessage(raw: unknown): ScreenMessage | null {
  let m: unknown = raw;
  if (typeof raw === "string") {
    try {
      m = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  const lang = o.lang === "fr" || o.lang === "en" ? o.lang : undefined;
  switch (o.type) {
    case "contact_card":
      return { type: "contact_card", lang };
    case "message_sent":
      return {
        type: "message_sent",
        kind: SENT_KINDS.includes(o.kind as SentKind) ? (o.kind as SentKind) : "message",
        to: displayName(o.to),
        lang,
      };
    case "project_request": {
      const fields = parseProjectFields(o.fields);
      if (!fields || (o.status !== "draft" && o.status !== "sent")) return null;
      return { type: "project_request", status: o.status, fields, lang };
    }
    case "directions": {
      // The QR is generated client-side from maps_url, so only an https URL
      // of sane length ever becomes a code on the kiosk screen.
      if (typeof o.address !== "string" || !o.address.trim()) return null;
      if (typeof o.maps_url !== "string" || !/^https:\/\/\S+$/.test(o.maps_url) || o.maps_url.length > 500) return null;
      return { type: "directions", address: o.address.trim().slice(0, 200), maps_url: o.maps_url, lang };
    }
    case "recording":
      if (o.status !== "on" && o.status !== "off") return null;
      return { type: "recording", status: o.status, lang };
    case "press":
      if (!PRESS_BUTTONS.includes(o.button as PressButton)) return null;
      return { type: "press", button: o.button as PressButton };
    case "call_open":
      if (typeof o.url !== "string" || !/^wss?:\/\//.test(o.url) || typeof o.token !== "string" || !o.token) return null;
      return { type: "call_open", url: o.url, token: o.token, to: displayName(o.to), lang };
    case "call_close":
      return { type: "call_close" };
    case "call_answered":
      return { type: "call_answered" };
    case "dismiss":
      return { type: "dismiss" };
    default:
      return null;
  }
}

// "resume": the visitor tapped the "say my name" banner while she was paused.
// "wake": the visitor tapped the "say my name or tap to talk" hint while she was
// listening but nobody had spoken for a while.
// "call_cancel": the visitor cancelled a call (#22) before it was answered.
export type ControlMessage = { type: "resume" } | { type: "wake" } | { type: "call_cancel" };

// Window messages between the kiosk's top page and the receptionist embed
// (docs/screen-protocol.md, section 5). Same origin only.
//   embed -> page: Mia pressed an on-screen button for the visitor (#2). The
//   top page triggers the same action as a tap: Controls handles mute,
//   unmute, vr and recenter; MiaPressRouter opens the meeting rooms.
export type PressMessage = { type: "receptionist-press"; button: PressButton };

// For a video call to staff (#22). Same
// origin only: the kiosk token rides in "receptionist-call".
//   embed -> page: open the call window and join the call room.
export type CallOpenMessage = { type: "receptionist-call"; url: string; token: string; to?: string; lang?: Lang };
//   embed -> page: the worker closed the call (no answer, cancelled).
export type CallCloseMessage = { type: "receptionist-call-close" };
//   page -> embed: the team member is in the call (answered) / the window closed
//   (byVisitor: Cancel, ✕ or Leave, as opposed to the call ending on its own).
export type CallAnsweredMessage = { type: "call-answered" };
export type CallClosedMessage = { type: "call-closed"; answered: boolean; byVisitor: boolean };

