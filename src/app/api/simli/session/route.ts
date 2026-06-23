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

// Simli calls {baseURL}/chat/completions and needs a STREAMING SSE response.
// Anthropic's compat endpoint only streams with stream:true, which Simli does
// not send — so we route through our own /api/llm proxy (it forces stream:true
// and pipes the SSE back). This MUST be the public deployed origin; Simli
// cannot reach localhost. Set SIMLI_LLM_BASE_URL to "https://<your-domain>/api/llm".
const DEFAULT_LLM_BASE_URL =
  process.env.SIMLI_LLM_BASE_URL?.trim() ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api/llm`
    : "https://officemal.mobileappslabs.ca/api/llm");

// First thing the avatar says on its own when the session opens (no user input
// needed). Override with SIMLI_FIRST_MESSAGE.
const DEFAULT_FIRST_MESSAGE =
  process.env.SIMLI_FIRST_MESSAGE?.trim() ||
  "Hi there! Welcome to Mobile Apps Labs. How can I help you today?";

const DEFAULT_SYSTEM_PROMPT =
  process.env.SIMLI_SYSTEM_PROMPT?.trim() ||
  [
    "You are Mia, the virtual receptionist at Mobile Apps Labs, a software studio",
    "based in Montréal that builds mobile apps, web platforms, and immersive 3D",
    "experiences for clients in retail, finance, and hospitality. You speak from a",
    "touchscreen kiosk in the office lobby. The visitor in front of you is either a",
    "client, a candidate, or a guest dropping by.",
    "",
    "How to respond:",
    "- Speak warmly and concisely. 1 to 3 short sentences. No bullet lists.",
    "- Sound like a real person at a reception desk. Conversational, never robotic.",
    "- If you don't know something, offer to take a message or point them to the",
    "  right team rather than making things up.",
  ].join(" ");

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

  // Simli's LLM hook is `llmConfig`, NOT `customLLMConfig` (unknown fields are
  // silently ignored, which produces a connected-but-silent avatar). For a
  // custom endpoint like Anthropic's OpenAI-compatible API, provider must be
  // 'User' (provider 'OpenAI' rejects non-OpenAI models and forbids a custom
  // baseURL). Confirmed against Simli's 422 validation messages.
  const requestBody: Record<string, unknown> = {
    faceId: DEFAULT_FACE_ID,
    llmConfig: {
      model: DEFAULT_LLM_MODEL,
      provider: "User",
      apiKey: anthropicKey,
      baseURL: DEFAULT_LLM_BASE_URL,
    },
    ttsProvider: process.env.SIMLI_TTS_PROVIDER?.trim() || "Cartesia",
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    firstMessage: DEFAULT_FIRST_MESSAGE,
    language: process.env.SIMLI_LANGUAGE?.trim() || "en",
    maxSessionLength: Number(process.env.SIMLI_MAX_SESSION_LENGTH) || 600,
    maxIdleTime: Number(process.env.SIMLI_MAX_IDLE_TIME) || 60,
  };

  // Optional TTS overrides (ttsProvider defaults to Cartesia above). Override
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
    // Simli's start endpoint rate-limits rapid session creation (429). Retry a
    // few times with backoff so a transient limit self-heals instead of
    // surfacing as a dead avatar.
    let res: Response | null = null;
    let lastText = "";
    const delays = [0, 1200, 2500, 4000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]));
      res = await fetch(SIMLI_URL, {
        method: "POST",
        headers: {
          "x-simli-api-key": simliApiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
        cache: "no-store",
      });
      if (res.status !== 429) break;
      lastText = await res.text();
      console.warn(`[simli/session] 429 rate-limited, retry ${attempt + 1}/${delays.length - 1}`);
    }

    if (!res || !res.ok) {
      const text = res?.status === 429 ? lastText : await (res?.text() ?? Promise.resolve(""));
      const status = res?.status ?? 0;
      console.error("[simli/session] Provider error:", status, text);
      const friendly =
        status === 429
          ? "Simli is rate-limiting new sessions. Wait a moment and try again."
          : `Provider returned ${status}`;
      return NextResponse.json({ error: friendly, detail: text }, { status: 502 });
    }

    const body = await res.json();
    console.log("[simli/session] sent config keys:", Object.keys(requestBody));
    console.log("[simli/session] Simli response:", JSON.stringify(body));
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
