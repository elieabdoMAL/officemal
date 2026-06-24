import { NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// LiveKit join-token endpoint for the Simli Trinity receptionist.
//
// The browser (SimliLiveKitPanel) POSTs here to get a short-lived token + the
// LiveKit server URL, then joins a fresh room. The self-hosted Python worker
// (agent-worker/) uses automatic dispatch (WorkerType.ROOM) to join that same
// room and render the Trinity avatar — so the browser never has to request an
// agent explicitly.
//
// Required env (LiveKit Cloud project → Settings → Keys):
//   LIVEKIT_URL        — wss://<project>.livekit.cloud
//   LIVEKIT_API_KEY    — API key
//   LIVEKIT_API_SECRET — API secret (server-only; never exposed to the browser)

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

    const at = new AccessToken(apiKey, apiSecret, { identity });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true, // publish the mic for push-to-talk
      canSubscribe: true, // receive the avatar's video + audio
    });

    // livekit-server-sdk v2: toJwt() is async.
    const token = await at.toJwt();

    return NextResponse.json({ token, url, room });
  } catch (err) {
    console.error("[livekit/token] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
