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
  return v === "paused" ? "paused" : "listening";
}

// Text-stream topics. lk.transcription is LiveKit's own (AgentSession publishes
// both sides of the conversation on it).
export const TOPIC_TRANSCRIPTION = "lk.transcription";
export const TOPIC_SCREEN = "mia.screen"; // worker -> screen, JSON ScreenMessage
export const TOPIC_CONTROL = "mia.control"; // screen -> worker, JSON ControlMessage

export const ATTR_TRANSCRIPTION_FINAL = "lk.transcription_final";
export const ATTR_SEGMENT_ID = "lk.segment_id";

export type SentKind = "message" | "notify" | "alert" | "suggestion" | "project_request";

export type ScreenMessage =
  | { type: "contact_card"; lang?: Lang }
  | { type: "message_sent"; kind?: SentKind; to?: string; lang?: Lang }
  | { type: "dismiss" };

const SENT_KINDS: SentKind[] = ["message", "notify", "alert", "suggestion", "project_request"];

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
        to: typeof o.to === "string" && o.to.trim() ? o.to.trim().slice(0, 80) : undefined,
        lang,
      };
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
