import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Simli Auto (E2E) session endpoint.
// Docs: https://docs.simli.com/api-reference/start-auto-session-from-config
//
// In Auto/E2E mode Simli runs the whole conversation loop server-side: STT on
// the user's mic, the LLM (we point it at Anthropic's Haiku via the OpenAI-
// compatible endpoint), and TTS. The browser only joins the returned LiveKit
// room, plays the avatar video/audio, and publishes the mic — exactly like
// LiveAvatar FULL mode, but with our own (much cheaper) LLM.
//
// Required env:
//   SIMLI_API_KEY        — Simli account key (header x-simli-api-key)
//   ANTHROPIC_API_KEY    — Anthropic Console key (sk-ant-…); spends Console
//                          credits, NOT your Claude subscription.
// Optional env (sensible defaults below):
//   NEXT_PUBLIC_SIMLI_FACE_ID, SIMLI_LLM_MODEL, SIMLI_LLM_BASE_URL,
//   SIMLI_TTS_PROVIDER, SIMLI_VOICE_ID, SIMLI_SYSTEM_PROMPT,
//   SIMLI_FIRST_MESSAGE, SIMLI_MAX_SESSION_LENGTH, SIMLI_MAX_IDLE_TIME

const SIMLI_URL =
  process.env.SIMLI_AUTO_URL ||
  "https://api.simli.ai/auto/start/configurable";

// Face chosen during the Simli trial. Override per-environment.
const DEFAULT_FACE_ID =
  process.env.NEXT_PUBLIC_SIMLI_FACE_ID?.trim() ||
  "d2a5c7c6-fed9-4f55-bcb3-062f7cd20103";

// Anthropic's OpenAI-compatibility endpoint. NOTE: Anthropic flags this layer
// as test-grade, not production. Fine for the trial; swap to a native /api/chat
// proxy before going live.
const DEFAULT_LLM_MODEL = process.env.SIMLI_LLM_MODEL?.trim() || "claude-haiku-4-5";
const DEFAULT_LLM_BASE_URL =
  process.env.SIMLI_LLM_BASE_URL?.trim() || "https://api.anthropic.com/v1";

const DEFAULT_SYSTEM_PROMPT =
  process.env.SIMLI_SYSTEM_PROMPT?.trim() ||
  "You are the friendly virtual receptionist for OfficeMal. Greet visitors warmly, " +
    "answer questions about the office and its services, and keep replies short and " +
    "conversational — one or two sentences, since they are spoken aloud.";

// Env values can pick up a stray BOM or surrounding whitespace depending on how
// they were set (some shells prepend ﻿ when piping). A BOM in an HTTP
// header value throws "Cannot convert argument to a ByteString", so scrub it.
function cleanEnv(v: string | undefined): string | undefined {
  return v?.replace(/^﻿/, "").trim();
}

export async function POST() {
  const simliApiKey = cleanEnv(process.env.SIMLI_API_KEY);
  if (!simliApiKey) {
    console.error("[simli/session] SIMLI_API_KEY env var is not set");
    return NextResponse.json(
      { error: "Server misconfiguration: SIMLI_API_KEY not set" },
      { status: 500 }
    );
  }

  const anthropicKey = cleanEnv(process.env.ANTHROPIC_API_KEY);
  if (!anthropicKey) {
    console.error("[simli/session] ANTHROPIC_API_KEY env var is not set");
    return NextResponse.json(
      { error: "Server misconfiguration: ANTHROPIC_API_KEY not set" },
      { status: 500 }
    );
  }

  // customLLMConfig is Simli's OpenAI-compatible hook — model + baseURL + key.
  // Pointing it at Anthropic's /v1 routes Haiku as the conversation brain.
  const requestBody: Record<string, unknown> = {
    faceId: DEFAULT_FACE_ID,
    customLLMConfig: {
      model: DEFAULT_LLM_MODEL,
      baseURL: DEFAULT_LLM_BASE_URL,
      llmAPIKey: anthropicKey,
    },
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    language: process.env.SIMLI_LANGUAGE?.trim() || "en",
    maxSessionLength: Number(process.env.SIMLI_MAX_SESSION_LENGTH) || 600,
    maxIdleTime: Number(process.env.SIMLI_MAX_IDLE_TIME) || 60,
  };

  const firstMessage = process.env.SIMLI_FIRST_MESSAGE?.trim();
  if (firstMessage) requestBody.firstMessage = firstMessage;

  // TTS: default to Simli's bundled Cartesia (no extra key needed). Override
  // ttsProvider/voiceId/ttsModel via env, and supply ttsAPIKey if you bring
  // your own ElevenLabs/PlayHT account.
  if (process.env.SIMLI_TTS_PROVIDER?.trim())
    requestBody.ttsProvider = process.env.SIMLI_TTS_PROVIDER.trim();
  if (process.env.SIMLI_VOICE_ID?.trim())
    requestBody.voiceId = process.env.SIMLI_VOICE_ID.trim();
  if (process.env.SIMLI_TTS_MODEL?.trim())
    requestBody.ttsModel = process.env.SIMLI_TTS_MODEL.trim();
  if (process.env.SIMLI_TTS_API_KEY?.trim())
    requestBody.ttsAPIKey = process.env.SIMLI_TTS_API_KEY.trim();

  try {
    const res = await fetch(SIMLI_URL, {
      method: "POST",
      headers: {
        "x-simli-api-key": simliApiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("[simli/session] Provider error:", res.status, text);
      return NextResponse.json(
        { error: `Provider returned ${res.status}`, detail: text },
        { status: 502 }
      );
    }

    const body = await res.json();
    const roomUrl = body?.roomUrl;
    if (!roomUrl) {
      console.error("[simli/session] No roomUrl in response:", body);
      return NextResponse.json(
        { error: "No roomUrl in provider response" },
        { status: 502 }
      );
    }

    return NextResponse.json({ roomUrl, sessionId: body?.sessionId ?? null });
  } catch (err) {
    console.error("[simli/session] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
