// Server-side PostHog capture (posthog-node). Best-effort: never throws into callers.
import "./env.js";
import { PostHog } from "posthog-node";
import { captureAiGeneration } from "@posthog/ai";

let client = null;

function getClient() {
  if (client !== null) return client;
  const key = process.env.POSTHOG_PROJECT_TOKEN;
  if (!key) {
    client = false; // not configured
    return client;
  }
  client = new PostHog(key, {
    host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
    flushAt: 1,        // small server — flush eagerly
    flushInterval: 0,
  });
  return client;
}

export function capture(event, properties = {}, distinctId = "server") {
  try {
    const c = getClient();
    if (!c) return;
    c.capture({ distinctId, event, properties });
  } catch {
    // monitoring must never break a request
  }
}

// LLM observability: emit a $ai_generation event for one Claude call. Best-effort
// — the primary generation already happened; this must never break it. Surfaces in
// PostHog → AI observability with model, tokens, cost, latency, and prompt/output.
export async function captureGeneration({ model, input, output, usage, latencyMs, distinctId = "server", properties = {} }) {
  try {
    const c = getClient();
    if (!c) return;
    await captureAiGeneration(c, {
      distinctId,
      provider: "anthropic",
      model,
      input,
      output,
      usage: { inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens },
      latency: latencyMs != null ? latencyMs / 1000 : undefined,
      properties,
    });
  } catch {
    // observability is best-effort
  }
}

// Flush all queued events before process shutdown.
export async function shutdown() {
  try {
    const c = getClient();
    if (c) await c.shutdown();
  } catch { /* best-effort */ }
}

// Public config the browser is allowed to know (no secrets).
export function publicConfig() {
  return {
    posthogToken: process.env.POSTHOG_PROJECT_TOKEN || null,
    posthogHost: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
  };
}
