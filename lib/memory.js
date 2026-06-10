// Kee's persistent memory — the workbook's "AI brain".
//
// One living memory document, maintained by Claude Fable (1M context), covering
// everything that has happened across the workbook: voice-call transcripts,
// feedback comments, shared documents, and published versions. It is injected
// into every voice session so Kee starts each call already knowing the history.
//
// Two maintenance modes:
//   updateAfterConversation(id) — incremental: merge one new transcript in.
//   rebuild()                   — full: re-read everything and rewrite memory.
import Anthropic from "@anthropic-ai/sdk";

import "./env.js";
import { requireSupabase } from "./supabase.js";
import { DEPT_NAMES } from "./versions.js";

const MEMORY_MODEL = process.env.MEMORY_MODEL || "claude-fable-5";
const MEMORY_ID = "global";
export const MEMORY_CHAR_CAP = 18000; // what we inject into voice prompts

const MEMORY_SYSTEM = `You maintain the long-term memory of "Covalent Kee" — the AI running discovery for Covalent's operating-system workbook (six functions: Supply Chain (Ops), ICP & Persona Discovery, Ideal Hiring Profile, Sales, Marketing, HR).

You write THE memory document Kee reads before every voice call. Optimize it for a voice agent: dense, factual, attributed, and current. Structure it exactly as:

WORKBOOK STATE — 3-5 sentences: where discovery stands overall, momentum, what's converging or contested.

Then one section per function that has any history (skip silent ones):
## <Function name>
- What the team has said (attributed: "Keith: ...", "Dr. M: ..."), merged across calls/feedback/documents — keep the strongest, most decision-relevant points
- Confirmed vs contested: where people agree, where they disagree (name names)
- Open questions still unanswered
- Documents shared (title, who, the one key fact each adds)
- Version history one-liner (v2 folded X, v3 folded Y)

PEOPLE — one line per contributor: role/perspective as revealed, what they care about, functions they've touched.

Rules: never invent; attribute everything; prefer specifics (numbers, names, dates) over generalities; when new input contradicts old memory, keep both with dates and flag the conflict; total length under ${MEMORY_CHAR_CAP} characters — compress oldest, least-decision-relevant material first.`;

export async function getMemory() {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from("agent_memory")
    .select("content, stats, updated_at")
    .eq("id", MEMORY_ID)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function saveMemory(content, stats) {
  const sb = requireSupabase();
  const { error } = await sb.from("agent_memory").upsert({
    id: MEMORY_ID,
    content: String(content || "").slice(0, MEMORY_CHAR_CAP * 2),
    stats: stats || null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function runFable(userPrompt) {
  const client = new Anthropic();
  const stream = client.messages.stream({
    model: MEMORY_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: MEMORY_SYSTEM,
    messages: [{ role: "user", content: userPrompt }],
  });
  const message = await stream.finalMessage();
  const text = message.content.find((b) => b.type === "text")?.text || "";
  return { text: text.trim(), usage: message.usage };
}

// ---------------------------------------------------------------------------
// Incremental: fold one finished conversation into memory. Cheap and fast —
// runs every time a call with real content ends.
// ---------------------------------------------------------------------------
export async function updateAfterConversation(conversationId) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const sb = requireSupabase();

  const { data: conv } = await sb
    .from("conversations")
    .select("id, dept, agent, user_name, doc_version, started_at")
    .eq("id", conversationId)
    .single();
  if (!conv) return null;
  const { data: turns } = await sb
    .from("turns")
    .select("role, text")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (!turns || turns.length < 4) return null; // nothing memorable

  const existing = (await getMemory())?.content || "(no memory yet — start one)";
  const transcript = turns
    .map((t) => `${t.role === "agent" ? "Kee" : conv.user_name || "Caller"}: ${t.text}`)
    .join("\n");

  const prompt = `Update the memory document with one new voice call.

=== CURRENT MEMORY ===
${existing}

=== NEW CALL — ${DEPT_NAMES[conv.dept] || conv.dept} (v${conv.doc_version || "?"}), with ${conv.user_name || "an unnamed caller"}, ${String(conv.started_at).slice(0, 10)} ===
${transcript}

Return the COMPLETE updated memory document (not a diff).`;

  const { text, usage } = await runFable(prompt);
  if (!text) return null;
  await saveMemory(text, { last_op: "conversation", conversation_id: conversationId, usage });
  return { updated: true };
}

// ---------------------------------------------------------------------------
// Full rebuild: re-read everything. Runs after version generation, document
// uploads, or on demand. Fable's 1M context takes the whole history at once.
// ---------------------------------------------------------------------------
export async function rebuild() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const e = new Error("Memory is not configured (set ANTHROPIC_API_KEY)");
    e.code = "not_configured";
    throw e;
  }
  const sb = requireSupabase();

  const [fb, convs, docs, vers] = await Promise.all([
    sb.from("covalent_feedback").select("dept, author_name, comment, created_at").order("created_at", { ascending: true }).limit(500),
    sb.from("conversations").select("id, dept, user_name, doc_version, started_at").order("started_at", { ascending: true }).limit(200),
    sb.from("shared_documents").select("dept, title, shared_by, text_content, version_folded, created_at").order("created_at", { ascending: true }).limit(100),
    sb.from("dept_versions").select("dept, version, created_by, change_summary, created_at").order("created_at", { ascending: true }).limit(100),
  ]);

  const parts = [`Rebuild the memory document from the complete workbook history below.`];

  parts.push(`\n=== FEEDBACK COMMENTS (${fb.data?.length || 0}) ===`);
  for (const f of fb.data || []) parts.push(`[${String(f.created_at).slice(0, 10)}] ${DEPT_NAMES[f.dept] || f.dept} — ${f.author_name}: ${f.comment}`);

  parts.push(`\n=== VOICE CALLS (${convs.data?.length || 0}) ===`);
  for (const c of convs.data || []) {
    const { data: turns } = await sb
      .from("turns").select("role, text").eq("conversation_id", c.id).order("created_at", { ascending: true });
    if (!turns || turns.length < 4) continue;
    parts.push(`--- ${DEPT_NAMES[c.dept] || c.dept} (v${c.doc_version || "?"}), ${c.user_name || "unnamed"}, ${String(c.started_at).slice(0, 10)} ---`);
    parts.push(turns.map((t) => `${t.role === "agent" ? "Kee" : c.user_name || "Caller"}: ${t.text}`).join("\n"));
  }

  parts.push(`\n=== SHARED DOCUMENTS (${docs.data?.length || 0}) ===`);
  for (const d of docs.data || []) {
    parts.push(`--- "${d.title}" on ${DEPT_NAMES[d.dept] || d.dept}, shared by ${d.shared_by || "unknown"}, ${String(d.created_at).slice(0, 10)}${d.version_folded ? `, folded into v${d.version_folded}` : ""} ---`);
    if (d.text_content) parts.push(d.text_content.slice(0, 20000));
  }

  parts.push(`\n=== PUBLISHED VERSIONS (${vers.data?.length || 0}) ===`);
  for (const v of vers.data || []) parts.push(`${DEPT_NAMES[v.dept] || v.dept} v${v.version}${v.created_by ? ` by ${v.created_by}` : ""} [${String(v.created_at).slice(0, 10)}]: ${v.change_summary || "original"}`);

  parts.push(`\nReturn the complete memory document.`);

  const { text, usage } = await runFable(parts.join("\n"));
  if (!text) { const e = new Error("Memory model returned nothing"); e.code = "bad_model_output"; throw e; }
  await saveMemory(text, {
    last_op: "rebuild",
    counts: { feedback: fb.data?.length || 0, calls: convs.data?.length || 0, docs: docs.data?.length || 0, versions: vers.data?.length || 0 },
    usage,
  });
  return { rebuilt: true, chars: text.length };
}
