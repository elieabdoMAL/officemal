import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// LiveAvatar (formerly HeyGen Interactive Avatar) session-token endpoint.
// Docs: https://docs.liveavatar.com/api-reference/sessions/create-session-token
//
// Required: HEYGEN_API_KEY (header X-API-KEY) and an avatar UUID.
// We default to the public "Ann Therapist" avatar; override with
// NEXT_PUBLIC_HEYGEN_AVATAR_ID (or hit /v1/avatars/public to pick another).
//
// Response shape: { code, data: { session_id, session_token }, message }.

const TOKEN_URL =
  process.env.HEYGEN_TOKEN_URL || "https://api.liveavatar.com/v1/sessions/token";

const DEFAULT_AVATAR_ID = "513fd1b7-7ef9-466d-9af2-344e51eeb833"; // Ann Therapist
const DEFAULT_VOICE_ID = "de5574fc-009e-4a01-a881-9919ef8f5a0c"; // Ann - IA
// Context = persona + system prompt + LLM config, owned in the LiveAvatar
// dashboard. We currently auto-pin to the "OfficeMal Receptionist" context.
const DEFAULT_CONTEXT_ID = "462d5ce5-3f79-45bf-bc45-161f5f7b57b2";

export async function POST() {
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) {
    console.error("[heygen/token] HEYGEN_API_KEY env var is not set");
    return NextResponse.json(
      { error: "Server misconfiguration: HEYGEN_API_KEY not set" },
      { status: 500 }
    );
  }

  const avatarId =
    process.env.NEXT_PUBLIC_HEYGEN_AVATAR_ID?.trim() || DEFAULT_AVATAR_ID;
  const voiceId =
    process.env.HEYGEN_VOICE_ID?.trim() || DEFAULT_VOICE_ID;
  const contextId =
    process.env.HEYGEN_CONTEXT_ID?.trim() || DEFAULT_CONTEXT_ID;

  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "FULL",
        avatar_id: avatarId,
        avatar_persona: {
          voice_id: voiceId,
          context_id: contextId,
        },
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("[heygen/token] Provider error:", res.status, text);
      return NextResponse.json(
        { error: `Provider returned ${res.status}`, detail: text },
        { status: 502 }
      );
    }

    const body = await res.json();
    const token = body?.data?.session_token ?? body?.data?.token ?? body?.token;
    if (!token) {
      console.error("[heygen/token] No session_token in response:", body);
      return NextResponse.json(
        { error: "No session_token in provider response" },
        { status: 502 }
      );
    }

    return NextResponse.json({ token });
  } catch (err) {
    console.error("[heygen/token] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
