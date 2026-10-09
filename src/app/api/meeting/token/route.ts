import { NextRequest, NextResponse } from "next/server";
import { AccessToken, RoomConfiguration } from "livekit-server-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Join-token endpoint for the public meeting room (replaces the Google Meet
// link). Everyone who joins — from the 3D tour's "public-meeting" hotspot or
// the shareable /meet page — lands in the same fixed room, so they meet each
// other. Same LiveKit project as the AI receptionist; Mia stays out because her
// worker only joins rooms that request her by name, and this one doesn't.
//
// Required env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
// Optional: MEETING_ROOM_NAME (default "officemal-public").

const ROOM = process.env.MEETING_ROOM_NAME?.trim() || "officemal-public";

// Limits. It's a public room with no accounts, so it is capped rather than
// trusted: a full room refuses the next joiner, and an empty one closes itself
// (it reopens on the next join — same name, so the link never changes).
//   MAX_PARTICIPANTS — a lobby meeting, not a webinar
//   EMPTY_TIMEOUT_S  — room created but nobody connected
//   DEPARTURE_TIMEOUT_S — close this long after the last person leaves
//   TOKEN_TTL        — only needed to join; a leaked token goes stale fast
const MAX_PARTICIPANTS = 20;
const EMPTY_TIMEOUT_S = 120;
const DEPARTURE_TIMEOUT_S = 30;
const TOKEN_TTL = "15m";

const MAX_NAME_LENGTH = 40;

// Same scrub as the receptionist's token route: env values can pick up a stray
// BOM or surrounding whitespace.
function cleanEnv(v: string | undefined): string | undefined {
  return v?.replace(/^﻿/, "").trim();
}

export async function POST(req: NextRequest) {
  const url = cleanEnv(process.env.LIVEKIT_URL);
  const apiKey = cleanEnv(process.env.LIVEKIT_API_KEY);
  const apiSecret = cleanEnv(process.env.LIVEKIT_API_SECRET);

  if (!url || !apiKey || !apiSecret) {
    console.error("[meeting/token] LIVEKIT_URL/API_KEY/API_SECRET not all set");
    return NextResponse.json(
      { error: "Server misconfiguration: LiveKit env vars not set" },
      { status: 500 }
    );
  }

  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // The display name is the only thing a guest controls; everyone in the room
  // sees it, so keep it short and strip control characters.
  const name =
    typeof body.name === "string"
      ? body.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME_LENGTH)
      : "";
  if (!name) {
    return NextResponse.json({ error: "Please enter your name" }, { status: 400 });
  }

  try {
    // A random identity per join, so two guests called "Sam" don't kick each
    // other out (LiveKit replaces a participant who reuses an identity).
    const at = new AccessToken(apiKey, apiSecret, {
      identity: `guest-${crypto.randomUUID()}`,
      name,
      ttl: TOKEN_TTL,
    });
    at.addGrant({
      roomJoin: true,
      room: ROOM,
      canPublish: true, // camera, mic, screen share
      canSubscribe: true,
      canPublishData: true, // in-room chat
    });
    at.roomConfig = new RoomConfiguration({
      maxParticipants: MAX_PARTICIPANTS,
      emptyTimeout: EMPTY_TIMEOUT_S,
      departureTimeout: DEPARTURE_TIMEOUT_S,
    });

    return NextResponse.json({ token: await at.toJwt(), url });
  } catch (err) {
    console.error("[meeting/token] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
