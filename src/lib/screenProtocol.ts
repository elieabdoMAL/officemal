// The kiosk screen's side of docs/screen-protocol.md: what the worker can tell
// the screen (her state, her language, cards to show) and what the screen can
// tell the worker (the visitor tapped). Keep the two in step.

import type { Lang } from "@/lib/assistant";

// Participant attributes the worker sets on itself.
export const ATTR_STATE = "mia.state";
export const ATTR_LANGUAGE = "mia.language";

// "listening": in a conversation (the default when the attribute is missing).
// "paused": she was told to stop talking and waits for her name (#24, #25).
// "handover": a team member joined by video (#22); she is quiet until they leave.
// Anything else is shown as "listening".
export type MiaState = "listening" | "paused" | "handover";

export function asMiaState(v: unknown): MiaState {
  return v === "paused" || v === "handover" ? v : "listening";
}

// Team members she calls in by video (#22) join the kiosk's room as
// "staff-<team.json id>", named with their display name. The kiosk itself is
// "visitor-<uuid>" (/api/livekit/token).
export const STAFF_PREFIX = "staff-";
export const VISITOR_PREFIX = "visitor-";

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

export type SentKind = "message" | "notify" | "alert" | "suggestion" | "project_request";

// The project request form (#20), field key -> value, in the order the worker
// sent them (its PROJECT_FIELDS, agent-worker/leads.py). Empty = not given.
export type ProjectFields = [key: string, value: string][];
export type ProjectStatus = "draft" | "sent";

export type ScreenMessage =
  | { type: "contact_card"; lang?: Lang }
  | { type: "message_sent"; kind?: SentKind; to?: string; lang?: Lang }
  | { type: "project_request"; status: ProjectStatus; fields: ProjectFields; lang?: Lang }
  | { type: "calling"; to?: string; lang?: Lang }
  | { type: "dismiss" };

const SENT_KINDS: SentKind[] = ["message", "notify", "alert", "suggestion", "project_request"];

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
    case "calling":
      return { type: "calling", to: displayName(o.to), lang };
    case "dismiss":
      return { type: "dismiss" };
    default:
      return null;
  }
}

// "resume": the visitor tapped the "say my name" banner while she was paused.
// "wake": the visitor tapped the "say my name or tap to talk" hint while she was
// listening but nobody had spoken for a while.
export type ControlMessage = { type: "resume" } | { type: "wake" };
