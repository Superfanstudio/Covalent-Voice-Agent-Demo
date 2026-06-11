// Single LLM entry point for all server-side generation, via OpenRouter
// (OpenAI-compatible Chat Completions). Replaces direct @anthropic-ai/sdk calls
// so the same Claude models (opus-4.8 generation, fable-5 memory) run through the
// project's OpenRouter key. Best-effort: throws tagged errors callers can map.
import "./env.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Bare model names used across the app → OpenRouter slugs (dotted, namespaced).
const MODEL_MAP = {
  "claude-opus-4-8": "anthropic/claude-opus-4.8",
  "claude-fable-5": "anthropic/claude-fable-5",
};
export function mapModel(m) { return MODEL_MAP[m] || m; }

function apiKey() {
  return process.env.OPENROUTER_API_KEY || process.env.OPENROUTE_API_KEY || "";
}
export function llmConfigured() { return !!apiKey(); }

// Anthropic-style message content → OpenAI-compatible parts. Accepts a plain
// string, or an array of {type:"text"|"image"} blocks (images as base64 source).
function toContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "image" && b.source?.type === "base64") {
      return { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
    }
    return { type: "text", text: "" };
  });
}

// generate({ model, system, content, schema, maxTokens }) -> { text, usage }
// usage is normalized to { input_tokens, output_tokens } for captureGeneration.
export async function generate({ model, system, content, schema, maxTokens = 4000 }) {
  const key = apiKey();
  if (!key) { const e = new Error("OpenRouter API key is not set (OPENROUTER_API_KEY)"); e.code = "not_configured"; throw e; }

  const body = {
    model: mapModel(model),
    max_tokens: maxTokens,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: toContent(content) },
    ],
  };
  if (schema) {
    // strict:false — guide output to the schema without rejecting on minor
    // deviations; callers still JSON.parse and handle bad output.
    body.response_format = { type: "json_schema", json_schema: { name: "result", strict: false, schema } };
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "HTTP-Referer": "https://keemakr.ai",
      "X-Title": "Covalent Operating System",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const e = new Error(`OpenRouter ${res.status}: ${t.slice(0, 300)}`);
    e.code = res.status === 401 ? "not_configured" : "llm_error";
    throw e;
  }
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || "";
  const u = j.usage || {};
  return { text, usage: { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens } };
}
