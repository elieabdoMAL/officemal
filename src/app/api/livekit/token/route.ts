import { NextResponse } from "next/server";
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// LiveKit join-token endpoint for the Simli Trinity receptionist.
//
// The browser (SimliLiveKitPanel) POSTs here to get a short-lived token + the
// LiveKit server URL, then joins a fresh room. The token itself asks for the
// self-hosted Python worker (agent-worker/) by name, and LiveKit dispatches it
// into the room to render the Trinity avatar. Explicit dispatch, because the
// LiveKit project is shared with expo360: an automatically dispatched worker
// would join every room on the project, not just the kiosk's.
//
// Required env (LiveKit Cloud project → Settings → Keys):
//   LIVEKIT_URL        — wss://<project>.livekit.cloud
//   LIVEKIT_API_KEY    — API key
//   LIVEKIT_API_SECRET — API secret (server-only; never exposed to the browser)
// Optional:
//   LIVEKIT_AGENT_NAME — must match the worker's (same default on both sides)

const AGENT_NAME = process.env.LIVEKIT_AGENT_NAME?.trim() || "officemal-mia";

// Room limits, so a kiosk room can't outlive its visitor. The conversation
// limits themselves (2 min idle, 10 min max) live in the worker, which deletes
// the room when either trips; these cover the cases where it can't.
//   emptyTimeout     — the room was created but nobody ever joined
//   departureTimeout — everyone left without the worker deleting the room
//   TOKEN_TTL        — only needed to join; a leaked token goes stale fast
const EMPTY_TIMEOUT_S = 60;
const DEPARTURE_TIMEOUT_S = 10;
const TOKEN_TTL = "15m";

// Env values can pick up a stray BOM or surrounding whitespace; scrub them
// (same helper used by the Simli session route).
function cleanEnv(v: string | undefined): string | undefined {
  return v?.replace(/^﻿/, "").trim();
}

export async function POST() {
  const url = cleanEnv(process.env.LIVEKIT_URL);
  const apiKey = cleanEnv(process.env.LIVEKIT_API_KEY);
  const apiSecret = cleanEnv(process.env.LIVEKIT_API_SECRET);

  if (!url || !apiKey || !apiSecret) {
    console.error("[livekit/token] LIVEKIT_URL/API_KEY/API_SECRET not all set");
    return NextResponse.json(
      { error: "Server misconfiguration: LiveKit env vars not set" },
      { status: 500 }
    );
  }

  try {
    // Fresh room + identity per visitor so kiosk sessions never collide.
    const room = `kiosk-${crypto.randomUUID()}`;
    const identity = `visitor-${crypto.randomUUID()}`;

    const at = new AccessToken(apiKey, apiSecret, { identity, ttl: TOKEN_TTL });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true, // publish the mic for push-to-talk
      canSubscribe: true, // receive the avatar's video + audio
    });
    // Applied when this join creates the room — which it always does, since
    // the room name is fresh.
    at.roomConfig = new RoomConfiguration({
      emptyTimeout: EMPTY_TIMEOUT_S,
      departureTimeout: DEPARTURE_TIMEOUT_S,
      agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })],
    });

    // livekit-server-sdk v2: toJwt() is async.
    const token = await at.toJwt();

    return NextResponse.json({ token, url, room });
  } catch (err) {
    console.error("[livekit/token] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
