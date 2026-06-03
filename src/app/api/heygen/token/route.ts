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

// Avatar look ID — pick a green-screen look so the panorama embed can
// chroma-key the background to transparent in the browser. Override per
// environment with NEXT_PUBLIC_HEYGEN_AVATAR_ID.
const DEFAULT_AVATAR_ID = "075abc67-2fae-4548-8ca9-b815fcbd34c7";
// LiveAvatar requires a context (persona + system prompt + LLM) on FULL-mode
// sessions; default to the OfficeMal Receptionist context created in the
// LiveAvatar dashboard. Override with HEYGEN_CONTEXT_ID.
const DEFAULT_CONTEXT_ID = "f3f90002-6a15-4f0e-94af-3692d6014585";
// Voice falls back to whatever the avatar is configured with in the dashboard.
// Override with HEYGEN_VOICE_ID.

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
  const voiceId = process.env.HEYGEN_VOICE_ID?.trim();
  const contextId =
    process.env.HEYGEN_CONTEXT_ID?.trim() || DEFAULT_CONTEXT_ID;

  const persona: Record<string, string> = { context_id: contextId };
  if (voiceId) persona.voice_id = voiceId;

  const requestBody = {
    mode: "FULL",
    avatar_id: avatarId,
    avatar_persona: persona,
  };

  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
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
