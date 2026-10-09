import { NextResponse } from "next/server";
import { RoomServiceClient, TokenVerifier } from "livekit-server-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ends a video call to staff (#22) for both sides: deletes its room.
//
// The call has its own LiveKit room ("call-<uuid>", agent-worker/staff_call.py)
// that only the kiosk and the team member join. Whoever leaves posts their
// call token here (the kiosk's call window, StaffCallModal; the /join page),
// and the room is deleted: the other side is disconnected at once, and the
// email's link then says the visitor has left. LiveKit's departure timeout
// would close it anyway, but only once both have gone.
//
// Ending a call is all a token can do here, and only to its own call room.
// Tokens only need to be valid to *join*, and a call can outlast them, so an
// expired one is still accepted for this, up to CALL_TOKEN_GRACE.
//
// Body: { token }. Answer: { ok: true } or { error: "invalid" } with 401.

function cleanEnv(v: string | undefined): string | undefined {
  return v?.replace(/^﻿/, "").trim();
}

const CALL_ROOM_PREFIX = "call-";
const CALLER_PREFIXES = ["staff-", "visitor-"];
const CALL_TOKEN_GRACE = "3h";

export async function POST(req: Request) {
  const url = cleanEnv(process.env.LIVEKIT_URL);
  const apiKey = cleanEnv(process.env.LIVEKIT_API_KEY);
  const apiSecret = cleanEnv(process.env.LIVEKIT_API_SECRET);
  if (!url || !apiKey || !apiSecret) {
    console.error("[livekit/call-end] LIVEKIT_URL/API_KEY/API_SECRET not all set");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token || token.length > 4096) return NextResponse.json({ error: "invalid" }, { status: 401 });

  let claims;
  try {
    claims = await new TokenVerifier(apiKey, apiSecret).verify(token, CALL_TOKEN_GRACE);
  } catch {
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }
  const room = claims.video?.room ?? "";
  const identity = claims.sub ?? "";
  if (
    !claims.video?.roomJoin ||
    !room.startsWith(CALL_ROOM_PREFIX) ||
    !CALLER_PREFIXES.some((p) => identity.startsWith(p))
  ) {
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }

  try {
    await new RoomServiceClient(url.replace(/^ws/, "http"), apiKey, apiSecret).deleteRoom(room);
    console.log("[livekit/call-end]", identity, "ended", room);
  } catch (err) {
    // Already gone: the other side (or the worker) got there first.
    console.log("[livekit/call-end] room not deleted:", room, (err as Error)?.message);
  }
  return NextResponse.json({ ok: true });
}
