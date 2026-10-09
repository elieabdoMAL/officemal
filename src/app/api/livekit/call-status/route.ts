import { NextResponse } from "next/server";
import { RoomServiceClient, TokenVerifier } from "livekit-server-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Checks a staff join link (#22) before the /join page uses it.
//
// The receptionist worker opens a private room for each call ("call-<uuid>")
// and emails a team member a link to /join with a LiveKit token for it
// (agent-worker/staff_call.py). Before turning on their camera, the page
// POSTs the token here:
//   - the token must be ours (signed with LIVEKIT_API_SECRET), unexpired, and
//     a staff token for a call room — so a forged link can't point the page at
//     someone else's LiveKit server: the URL to join comes from here;
//   - the call room must still be open with the visitor (the kiosk, a
//     "visitor-…" participant) in it. The room is deleted when the call ends,
//     goes unanswered, or the visitor leaves; joining a room that's gone would
//     quietly create an empty one, with the team member waiting in it alone.
//
// Body: { token }. Answer: { url, room, name, visitor, visitorHere, expiresAt }
// or { error: "expired" | "invalid" } with 401.

function cleanEnv(v: string | undefined): string | undefined {
  return v?.replace(/^﻿/, "").trim();
}

const STAFF_PREFIX = "staff-";
const VISITOR_PREFIX = "visitor-";
const CALL_ROOM_PREFIX = "call-";

export async function POST(req: Request) {
  const url = cleanEnv(process.env.LIVEKIT_URL);
  const apiKey = cleanEnv(process.env.LIVEKIT_API_KEY);
  const apiSecret = cleanEnv(process.env.LIVEKIT_API_SECRET);
  if (!url || !apiKey || !apiSecret) {
    console.error("[livekit/call-status] LIVEKIT_URL/API_KEY/API_SECRET not all set");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token || token.length > 4096) return NextResponse.json({ error: "invalid" }, { status: 401 });

  let claims;
  try {
    claims = await new TokenVerifier(apiKey, apiSecret).verify(token);
  } catch (err) {
    const expired = (err as { code?: string })?.code === "ERR_JWT_EXPIRED";
    return NextResponse.json({ error: expired ? "expired" : "invalid" }, { status: 401 });
  }
  const room = claims.video?.room ?? "";
  const identity = claims.sub ?? "";
  if (!claims.video?.roomJoin || !room.startsWith(CALL_ROOM_PREFIX) || !identity.startsWith(STAFF_PREFIX)) {
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }

  let visitorHere = false;
  try {
    const rooms = new RoomServiceClient(url.replace(/^ws/, "http"), apiKey, apiSecret);
    const participants = await rooms.listParticipants(room);
    visitorHere = participants.some((p) => p.identity.startsWith(VISITOR_PREFIX));
  } catch (err) {
    // The room is gone (the call ended, or the visitor left): same answer.
    console.log("[livekit/call-status] room not available:", room, (err as Error)?.message);
  }

  let visitor = "";
  try {
    visitor = String(JSON.parse(claims.metadata || "{}").visitor ?? "").slice(0, 80);
  } catch {}

  return NextResponse.json({
    url,
    room,
    name: claims.name ?? "",
    visitor,
    visitorHere,
    expiresAt: claims.exp ?? null,
  });
}
