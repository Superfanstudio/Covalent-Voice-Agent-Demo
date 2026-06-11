// Kee's persistent memory — the workbook's "AI brain".
//
// One memory document PER FUNCTION (dept), maintained by Claude Fable, covering
// that function's voice-call transcripts, feedback, shared documents, and
// versions. Keyed by dept in agent_memory, so each agent's memory is isolated —
// an ICP call never sees Sales history. Injected into that function's voice calls.
//
// Two maintenance modes:
//   updateAfterConversation(id) — incremental: merge one new transcript into its dept's memory.
//   rebuild(dept) / rebuildAll() — full: re-read a function's (or every function's) history.
import "./env.js";
import { requireSupabase } from "./supabase.js";
import { DEPT_NAMES, DEPTS } from "./versions.js";
import { captureGeneration } from "./posthog.js";
import { generate, llmConfigured } from "./llm.js";

const MEMORY_MODEL = process.env.MEMORY_MODEL || "claude-fable-5";
export const MEMORY_CHAR_CAP = 18000; // what we inject into voice prompts

// Per-function memory: each function (dept) keeps its OWN memory document, keyed
// by dept in agent_memory — so an ICP call never sees Sales history.
const memorySystem = (fn) => `You maintain Covalent Kee's long-term memory for ONE function: "${fn}". You write THE memory document Kee reads before every voice call about ${fn}. Optimize it for a voice agent: dense, factual, attributed, and current. Structure it exactly as:

STATE — 3-5 sentences: where discovery on ${fn} stands, momentum, what's converging or contested.

KEY POINTS — what the team has said about ${fn} (attributed: "Keith: ...", "Dr. M: ..."), merged across calls, feedback, and documents — keep the strongest, most decision-relevant points.

CONFIRMED VS CONTESTED — where people agree, where they disagree (name names).

OPEN QUESTIONS — still unanswered for ${fn}.

DOCUMENTS — shared docs (title, who, the one key fact each adds).

PEOPLE — one line per contributor who has touched ${fn}: role/perspective as revealed, what they care about.

Rules: never invent; attribute everything; prefer specifics (numbers, names, dates) over generalities; when new input contradicts old memory, keep both with dates and flag the conflict; total length under ${MEMORY_CHAR_CAP} characters — compress oldest, least-decision-relevant material first.`;

export async function getMemory(dept) {
  if (!dept) return null;
  const sb = requireSupabase();
  const { data, error } = await sb
    .from("agent_memory")
    .select("content, stats, updated_at")
    .eq("id", dept)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function saveMemory(dept, content, stats) {
  const sb = requireSupabase();
  const { error } = await sb.from("agent_memory").upsert({
    id: dept,
    content: String(content || "").slice(0, MEMORY_CHAR_CAP * 2),
    stats: stats || null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function runFable(userPrompt, feature, system) {
  const start = Date.now();
  const { text: raw, usage } = await generate({
    model: MEMORY_MODEL,
    system,
    content: userPrompt,
    maxTokens: 16000,
  });
  const text = (raw || "").trim();
  captureGeneration({
    model: MEMORY_MODEL,
    input: [{ role: "system", content: system }, { role: "user", content: userPrompt }],
    output: text,
    usage,
    latencyMs: Date.now() - start,
    properties: { feature },
  });
  return { text, usage };
}

// ---------------------------------------------------------------------------
// Incremental: fold one finished conversation into memory. Cheap and fast —
// runs every time a call with real content ends.
// ---------------------------------------------------------------------------
export async function updateAfterConversation(conversationId) {
  if (!llmConfigured()) return null;
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

  const fn = DEPT_NAMES[conv.dept] || conv.dept;
  const existing = (await getMemory(conv.dept))?.content || "(no memory yet — start one)";
  const transcript = turns
    .map((t) => `${t.role === "agent" ? "Kee" : conv.user_name || "Caller"}: ${t.text}`)
    .join("\n");

  const prompt = `Update the ${fn} memory document with one new voice call.

=== CURRENT MEMORY (${fn}) ===
${existing}

=== NEW CALL — ${fn} (v${conv.doc_version || "?"}), with ${conv.user_name || "an unnamed caller"}, ${String(conv.started_at).slice(0, 10)} ===
${transcript}

Return the COMPLETE updated ${fn} memory document (not a diff).`;

  const { text, usage } = await runFable(prompt, "memory_update", memorySystem(fn));
  if (!text) return null;
  await saveMemory(conv.dept, text, { last_op: "conversation", conversation_id: conversationId, usage });
  return { updated: true, dept: conv.dept };
}

// ---------------------------------------------------------------------------
// Full rebuild: re-read everything. Runs after version generation, document
// uploads, or on demand. Fable's 1M context takes the whole history at once.
// ---------------------------------------------------------------------------
export async function rebuild(dept) {
  if (!llmConfigured()) {
    const e = new Error("Memory is not configured (set OPENROUTER_API_KEY)");
    e.code = "not_configured";
    throw e;
  }
  if (!dept) return rebuildAll();           // no dept → rebuild every function's memory
  const sb = requireSupabase();
  const fn = DEPT_NAMES[dept] || dept;

  // Everything for THIS function only.
  const [fb, convs, docs, vers] = await Promise.all([
    sb.from("covalent_feedback").select("author_name, comment, created_at").eq("dept", dept).order("created_at", { ascending: true }).limit(500),
    sb.from("conversations").select("id, user_name, doc_version, started_at").eq("dept", dept).order("started_at", { ascending: true }).limit(200),
    sb.from("shared_documents").select("title, shared_by, text_content, version_folded, created_at").eq("dept", dept).order("created_at", { ascending: true }).limit(100),
    sb.from("dept_versions").select("version, created_by, change_summary, created_at").eq("dept", dept).order("created_at", { ascending: true }).limit(100),
  ]);

  const parts = [`Rebuild the ${fn} memory document from this function's complete history below.`];

  parts.push(`\n=== FEEDBACK COMMENTS (${fb.data?.length || 0}) ===`);
  for (const f of fb.data || []) parts.push(`[${String(f.created_at).slice(0, 10)}] ${f.author_name}: ${f.comment}`);

  parts.push(`\n=== VOICE CALLS (${convs.data?.length || 0}) ===`);
  for (const c of convs.data || []) {
    const { data: turns } = await sb
      .from("turns").select("role, text").eq("conversation_id", c.id).order("created_at", { ascending: true });
    if (!turns || turns.length < 4) continue;
    parts.push(`--- v${c.doc_version || "?"}, ${c.user_name || "unnamed"}, ${String(c.started_at).slice(0, 10)} ---`);
    parts.push(turns.map((t) => `${t.role === "agent" ? "Kee" : c.user_name || "Caller"}: ${t.text}`).join("\n"));
  }

  parts.push(`\n=== SHARED DOCUMENTS (${docs.data?.length || 0}) ===`);
  for (const d of docs.data || []) {
    parts.push(`--- "${d.title}" shared by ${d.shared_by || "unknown"}, ${String(d.created_at).slice(0, 10)}${d.version_folded ? `, folded into v${d.version_folded}` : ""} ---`);
    if (d.text_content) parts.push(d.text_content.slice(0, 20000));
  }

  parts.push(`\n=== PUBLISHED VERSIONS (${vers.data?.length || 0}) ===`);
  for (const v of vers.data || []) parts.push(`v${v.version}${v.created_by ? ` by ${v.created_by}` : ""} [${String(v.created_at).slice(0, 10)}]: ${v.change_summary || "original"}`);

  parts.push(`\nReturn the complete ${fn} memory document.`);

  const { text, usage } = await runFable(parts.join("\n"), "memory_rebuild", memorySystem(fn));
  if (!text) { const e = new Error("Memory model returned nothing"); e.code = "bad_model_output"; throw e; }
  await saveMemory(dept, text, {
    last_op: "rebuild",
    counts: { feedback: fb.data?.length || 0, calls: convs.data?.length || 0, docs: docs.data?.length || 0, versions: vers.data?.length || 0 },
    usage,
  });
  return { rebuilt: true, dept, chars: text.length };
}

// Rebuild every function's memory (e.g. the admin "refresh" with no dept).
export async function rebuildAll() {
  const results = [];
  for (const dept of DEPTS) {
    try { results.push(await rebuild(dept)); }
    catch (e) { results.push({ dept, error: e.message }); }
  }
  return { rebuiltAll: true, results };
}
