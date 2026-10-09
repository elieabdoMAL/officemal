import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// OpenAI-compatible LLM proxy for Simli Auto.
//
// Why this exists: Simli's custom-LLM hook calls {baseURL}/chat/completions and
// REQUIRES a streaming text/event-stream response (chat.completion.chunk frames
// + a final `data: [DONE]`). Anthropic's OpenAI-compat endpoint only streams
// when stream:true is set — which Simli does NOT send. So pointing Simli
// straight at Anthropic yields a non-streaming JSON blob Simli can't parse, and
// the avatar stays silent.
//
// This route sits in between: Simli -> /api/llm/chat/completions -> Anthropic
// (stream:true) and pipes the SSE straight back. Point Simli's
// llmConfig.baseURL at `<your-deployed-origin>/api/llm` — Simli appends
// `/chat/completions`, which lands exactly here.
//
// NOTE: Simli's servers call this over the public internet, so it must be the
// deployed URL — localhost is unreachable from Simli (which is also why the
// conversation never worked in local dev).

const ANTHROPIC_URL = "https://api.anthropic.com/v1/chat/completions";

function cleanEnv(v: string | undefined): string | undefined {
  return v?.replace(/^﻿/, "").trim();
}

export async function POST(req: NextRequest) {
  const key = cleanEnv(process.env.ANTHROPIC_API_KEY);
  if (!key) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Force streaming on (Simli needs SSE) and pin the model to Haiku unless the
  // caller specified a claude-* model already.
  const model =
    typeof payload.model === "string" && payload.model.startsWith("claude")
      ? payload.model
      : "claude-haiku-4-5";

  const upstream = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...payload, model, stream: true }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    console.error("[llm/chat] upstream error:", upstream.status, text);
    return new Response(
      JSON.stringify({ error: `Upstream ${upstream.status}`, detail: text }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }

  // Pipe Anthropic's SSE straight through to Simli unchanged.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
