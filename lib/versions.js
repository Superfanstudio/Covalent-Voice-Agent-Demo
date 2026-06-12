// Versioned function documents: list/read versions, and generate a new version
// from accumulated feedback + voice-call transcripts using Claude.
//
// A "document" is one function's full section HTML (what the shell renders in
// an iframe). v1 is seeded from the original artifact. "Generate" gathers all
// feedback comments and conversation transcripts for that dept since the last
// version, asks Claude for targeted find/replace edits, applies them with
// change highlighting + a changelog banner, stores the result as version N+1,
// and re-ingests the dept's knowledge base from the new content.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { generate, llmConfigured } from "./llm.js";

import "./env.js";
import { requireSupabase } from "./supabase.js";
import { htmlToText } from "./extract.js";
import * as kb from "./kb.js";
import * as docsLib from "./docs.js";
import { captureGeneration } from "./posthog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEPTS = ["overview", "tools", "supply", "icp", "ihp", "sales", "marcom", "hr"];
export const DEPT_NAMES = {
  overview: "Activation Roadmap",
  tools: "Tool Selection",
  supply: "Ops — Supply Chain & Logistics",
  icp: "ICP & Persona Discovery",
  ihp: "Ideal Hiring Profile",
  sales: "Sales",
  marcom: "Marketing",
  hr: "HR",
};

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

// ---------------------------------------------------------------------------
// Reading versions
// ---------------------------------------------------------------------------

async function seedHtml(dept) {
  // v1 fallback when the DB has no rows yet: the artifact payload shipped with
  // the app (base64 per dept).
  const raw = await readFile(join(__dirname, "..", "data", "depts.json"), "utf8");
  const data = JSON.parse(raw);
  if (!data[dept]) return null;
  return Buffer.from(data[dept], "base64").toString("utf8");
}

export async function listVersions(dept) {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from("dept_versions")
    .select("version, change_summary, created_by, created_at")
    .eq("dept", dept)
    .order("version", { ascending: false });
  if (error) throw error;
  if (!data || data.length === 0) {
    return [{ version: 1, change_summary: "Original artifact", created_by: null, created_at: null, seed: true }];
  }
  return data;
}

export async function getVersion(dept, version) {
  const sb = requireSupabase();
  let q = sb
    .from("dept_versions")
    .select("dept, version, html, change_summary, change_log, created_by, created_at")
    .eq("dept", dept)
    .order("version", { ascending: false })
    .limit(1);
  if (version) q = q.eq("version", version);
  const { data, error } = await q;
  if (error) throw error;
  if (data && data.length) return data[0];
  // No rows (or requested v1 before seeding) → artifact fallback
  if (!version || Number(version) === 1) {
    const html = await seedHtml(dept);
    if (html) return { dept, version: 1, html, change_summary: "Original artifact", change_log: null, created_by: null, created_at: null, seed: true };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gathering inputs (feedback + transcripts since the last version)
// ---------------------------------------------------------------------------

async function gatherInputs(dept, sinceIso) {
  const sb = requireSupabase();

  let fq = sb
    .from("covalent_feedback")
    .select("id, author_name, comment, created_at")
    .eq("dept", dept)
    .order("created_at", { ascending: true });
  if (sinceIso) fq = fq.gt("created_at", sinceIso);
  const { data: feedback, error: fErr } = await fq;
  if (fErr) throw fErr;

  let cq = sb
    .from("conversations")
    .select("id, user_name, started_at")
    .eq("dept", dept)
    .order("started_at", { ascending: true });
  if (sinceIso) cq = cq.gt("started_at", sinceIso);
  const { data: convs, error: cErr } = await cq;
  if (cErr) throw cErr;

  const transcripts = [];
  for (const c of (convs || []).slice(-30)) {  // cap: the 30 most recent calls
    const { data: turns, error: tErr } = await sb
      .from("turns")
      .select("role, text")
      .eq("conversation_id", c.id)
      .order("created_at", { ascending: true });
    if (tErr) throw tErr;
    if (!turns || turns.length < 2) continue;  // skip empty/aborted calls
    transcripts.push({
      id: c.id,
      user_name: c.user_name || "Unknown caller",
      date: (c.started_at || "").slice(0, 10),
      text: turns.map((t) => `${t.role === "agent" ? "Kee" : c.user_name || "Caller"}: ${t.text}`).join("\n"),
    });
  }

  // Shared source documents contributed since the last version
  const documents = await docsLib.docsSince(dept, sinceIso);

  return { feedback: feedback || [], transcripts, documents };
}

// ---------------------------------------------------------------------------
// Virtual file map — sections that nest sub-pages as base64 JSON blobs (sales)
// are expanded so Claude can edit the *decoded* sub-pages.
// ---------------------------------------------------------------------------

const BLOB_RE = /(<script[^>]*type="application\/json"[^>]*>)([\s\S]*?)(<\/script>)/;
const B64ISH = /^[A-Za-z0-9+/=\s]{200,}/;

function explodeFiles(html) {
  const files = { main: html };
  const m = html.match(BLOB_RE);
  if (m) {
    try {
      const blob = JSON.parse(m[2]);
      let nested = false;
      for (const [key, val] of Object.entries(blob)) {
        if (typeof val === "string" && B64ISH.test(val.slice(0, 400))) {
          files[`page:${key}`] = Buffer.from(val, "base64").toString("utf8");
          nested = true;
        }
      }
      if (nested) files.__blob = blob; // keep parsed blob for reassembly
    } catch { /* not a payload blob — treat as plain html */ }
  }
  return files;
}

function implodeFiles(files) {
  let html = files.main;
  if (files.__blob) {
    const blob = files.__blob;
    for (const key of Object.keys(blob)) {
      const fk = `page:${key}`;
      if (files[fk] !== undefined) {
        blob[key] = Buffer.from(files[fk], "utf8").toString("base64");
      }
    }
    html = html.replace(BLOB_RE, (_, open, _old, close) => open + JSON.stringify(blob) + close);
  }
  return html;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const EDITS_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Two to four sentences summarizing what changed in this version and why, written for the team.",
    },
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string", description: "Which file the edit applies to: 'main' or one of the 'page:*' ids shown in the document. Use 'main' if only one file was shown." },
          find: { type: "string", description: "EXACT contiguous substring copied verbatim from the file, 40-400 characters, unique enough to match once." },
          replace: { type: "string", description: "The replacement text. Must be valid in context (HTML stays HTML, JS string content stays plain text with the same quoting)." },
          reason: { type: "string", description: "One sentence: why this change, grounded in the feedback or transcript." },
          source: { type: "string", description: "Attribution, e.g. 'Feedback — Maya, 2026-06-08' or 'Voice call — Keith, 2026-06-09'." },
        },
        required: ["file", "find", "replace", "reason", "source"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "changes"],
  additionalProperties: false,
};

const EDITOR_SYSTEM = `You are the document editor behind "Covalent Kee", maintaining Covalent's operating-system documents. You receive one function's current document (HTML, possibly split into multiple files), plus the feedback comments, voice-interview transcripts, and shared source documents (text and images) collected since the last version. You produce a set of minimal, surgical find/replace edits that fold the new input into the document.

Rules:
- Every edit must be grounded in a specific piece of feedback or a specific transcript statement. Do not invent content, and do not editorialize.
- "find" must be an EXACT verbatim substring of the file it targets — copy it character-for-character including whitespace, entities (&amp;), and punctuation. 40-400 characters, long enough to be unique.
- Keep edits minimal: change sentences and values, not structure. Never edit CSS, never change JavaScript logic — only the human-readable text inside markup or inside JS string literals.
- When the text you are changing is visible HTML body text, wrap the changed phrase in the replacement with: <mark class="kee-rev" title="REASON">changed text</mark> (keep REASON under 120 chars, no double quotes inside).
- When the text lives inside a JavaScript string literal or an HTML attribute, do NOT add any markup — plain text only, preserve the original quoting and escaping exactly.
- Where input contradicts the document, update the document to reflect the team's input. Where input confirms it, you may strengthen wording from "assumption" to "confirmed by the team".
- Aim for high-signal edits: typically 3 to 15 changes. If the inputs contain nothing document-worthy, return an empty changes array and say so in the summary.`;

function buildUserPrompt(dept, files, inputs, nextVersion) {
  const parts = [];
  parts.push(`Function: ${DEPT_NAMES[dept]} (dept key: ${dept}). You are producing version ${nextVersion}.`);

  parts.push(`\n=== NEW FEEDBACK COMMENTS (${inputs.feedback.length}) ===`);
  for (const f of inputs.feedback) {
    parts.push(`- [${(f.created_at || "").slice(0, 10)}] ${f.author_name}: ${f.comment}`);
  }

  parts.push(`\n=== NEW VOICE-CALL TRANSCRIPTS (${inputs.transcripts.length}) ===`);
  for (const t of inputs.transcripts) {
    parts.push(`--- Call with ${t.user_name} on ${t.date} ---\n${t.text}`);
  }

  const textDocs = inputs.documents.filter((d) => d.text_content && d.text_content.trim());
  const imageDocs = inputs.documents.filter((d) => /^image\//.test(d.mime || ""));
  parts.push(`\n=== NEW SHARED DOCUMENTS (${inputs.documents.length}) ===`);
  for (const d of textDocs) {
    // Generous per-doc cap — full workbooks routinely run 100k+ chars and the
    // generation model has a 1M-token window; truncating to a few pages loses
    // most of a contributor's input.
    parts.push(`--- "${d.title}", shared by ${d.shared_by || "unknown"} on ${String(d.created_at).slice(0, 10)} ---\n${d.text_content.slice(0, 160000)}`);
  }
  if (imageDocs.length) {
    parts.push(`(${imageDocs.length} shared image${imageDocs.length === 1 ? "" : "s"} attached to this message — treat their contents as shared input, attributed to the named sharer.)`);
  }

  parts.push(`\n=== CURRENT DOCUMENT ===`);
  for (const [name, content] of Object.entries(files)) {
    if (name === "__blob") continue;
    parts.push(`\n<<<FILE ${name}>>>\n${content}\n<<<END FILE ${name}>>>`);
  }

  parts.push(`\nProduce the edits now.`);
  return parts.join("\n");
}

function applyEdits(files, changes, version) {
  const applied = [];
  const skipped = [];
  for (const ch of changes || []) {
    const fk = files[ch.file] !== undefined ? ch.file : "main";
    const content = files[fk];
    if (typeof content !== "string" || !ch.find) { skipped.push({ ...ch, why: "bad target" }); continue; }
    const idx = content.indexOf(ch.find);
    if (idx === -1) { skipped.push({ ...ch, why: "find not matched" }); continue; }
    files[fk] = content.slice(0, idx) + ch.replace + content.slice(idx + ch.find.length);
    applied.push({ file: fk, excerpt: ch.find.slice(0, 120), reason: ch.reason, source: ch.source });
  }
  return { applied, skipped: skipped.map(({ find, reason, source, why }) => ({ excerpt: (find || "").slice(0, 120), reason, source, why })) };
}

const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function changelogBanner(version, summary, applied, inputs) {
  const items = applied
    .map((a) => `<li><span>${esc(a.reason)}</span> <em>${esc(a.source)}</em></li>`)
    .join("");
  return `
<div class="kee-changelog" id="keeChangelog">
  <style>
    .kee-changelog{font-family:'Spline Sans','Inter Tight',system-ui,sans-serif;background:#fdf8ec;border:1px solid #e8ddc2;border-left:4px solid #b8860b;border-radius:0 12px 12px 0;padding:14px 18px;margin:0 auto 26px;max-width:880px;color:#3d3829;font-size:13.5px;line-height:1.55}
    .kee-changelog .kc-hd{display:flex;align-items:center;gap:8px;font-weight:600;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#8a6d1d;margin-bottom:7px}
    .kee-changelog .kc-badge{background:#b8860b;color:#fff;border-radius:10px;padding:1px 9px;font-size:11px;letter-spacing:.04em}
    .kee-changelog ul{margin:8px 0 0;padding-left:18px}
    .kee-changelog li{margin:3px 0}
    .kee-changelog li em{color:#8a8265;font-style:normal;font-size:12px}
    .kee-changelog .kc-src{margin-top:8px;font-size:12px;color:#8a8265}
    mark.kee-rev{background:#fbe9a9;border-bottom:2px solid #d9a514;border-radius:3px;padding:0 2px;cursor:help}
  </style>
  <div class="kc-hd"><span class="kc-badge">v${version}</span> What changed in this version</div>
  <div>${esc(summary)}</div>
  ${items ? `<ul>${items}</ul>` : ""}
  <div class="kc-src">Generated by Covalent Kee from ${inputs.feedback.length} feedback comment${inputs.feedback.length === 1 ? "" : "s"} and ${inputs.transcripts.length} voice call${inputs.transcripts.length === 1 ? "" : "s"}. Changed passages are highlighted; hover a highlight for the reason. Previous versions remain available in the version selector.</div>
</div>`;
}

function injectBanner(html, banner) {
  // After the opening <body...> tag; fall back to prepending.
  const m = html.match(/<body[^>]*>/);
  if (m) return html.replace(m[0], m[0] + "\n" + banner);
  return banner + html;
}

export async function generateVersion({ dept, accessCode, createdBy }) {
  const required = process.env.VERSION_ACCESS_CODE;
  if (!required) {
    const e = new Error("Version generation is not configured (set VERSION_ACCESS_CODE)");
    e.code = "not_configured";
    throw e;
  }
  if (accessCode !== required) {
    const e = new Error("Invalid access code");
    e.code = "bad_access_code";
    throw e;
  }
  if (!DEPTS.includes(dept)) {
    const e = new Error(`Unknown dept "${dept}"`);
    e.code = "bad_dept";
    throw e;
  }
  if (!llmConfigured()) {
    const e = new Error("Version generation is not configured (set OPENROUTER_API_KEY)");
    e.code = "not_configured";
    throw e;
  }

  const current = await getVersion(dept);
  if (!current) {
    const e = new Error("No current document found for this function");
    e.code = "no_document";
    throw e;
  }
  const nextVersion = (current.version || 1) + 1;
  const since = current.seed ? null : current.created_at;

  const inputs = await gatherInputs(dept, since);
  if (inputs.feedback.length === 0 && inputs.transcripts.length === 0 && inputs.documents.length === 0) {
    const e = new Error(`No new feedback, voice transcripts, or shared documents for ${DEPT_NAMES[dept]} since v${current.version} — nothing to fold in yet.`);
    e.code = "no_inputs";
    throw e;
  }

  const files = explodeFiles(current.html);

  // Shared images go to the model as vision blocks (max 5, newest first).
  const content = [{ type: "text", text: buildUserPrompt(dept, files, inputs, nextVersion) }];
  const imageDocs = inputs.documents.filter((d) => /^image\/(png|jpe?g|gif|webp)/.test(d.mime || "")).slice(-5);
  for (const img of imageDocs) {
    try {
      const bytes = await docsLib.downloadBytes(img.storage_path);
      content.push({ type: "text", text: `Shared image: "${img.title}" (by ${img.shared_by || "unknown"}, ${String(img.created_at).slice(0, 10)}):` });
      content.push({ type: "image", source: { type: "base64", media_type: img.mime, data: bytes.toString("base64") } });
    } catch (err) {
      console.error(`[versions] could not attach image ${img.title}:`, err?.message || err);
    }
  }

  const start = Date.now();
  const { text: genText, usage } = await generate({
    model: MODEL,
    system: EDITOR_SYSTEM,
    content,
    schema: EDITS_SCHEMA,
    maxTokens: 32000,
  });
  captureGeneration({
    model: MODEL,
    input: [{ role: "system", content: EDITOR_SYSTEM },
            { role: "user", content: content.map((b) => b.type === "image" ? { type: "image", source: "[redacted]" } : b) }],
    output: genText || "",
    usage,
    latencyMs: Date.now() - start,
    distinctId: createdBy || "server",
    properties: { feature: "version_generate", dept, version: nextVersion },
  });
  let edits;
  try {
    edits = JSON.parse(genText || "{}");
  } catch {
    const e = new Error("The editor model returned an unparseable result — try again.");
    e.code = "bad_model_output";
    throw e;
  }

  const { applied, skipped } = applyEdits(files, edits.changes, nextVersion);
  let newHtml = implodeFiles(files);
  newHtml = injectBanner(newHtml, changelogBanner(nextVersion, edits.summary, applied, inputs));

  const sb = requireSupabase();

  // If this is the first generated version, persist the seed as v1 first so
  // the dropdown can always show the original.
  if (current.seed) {
    await sb.from("dept_versions").insert({
      dept, version: 1, html: current.html,
      change_summary: "Original artifact", created_by: null,
    });
  }

  const { error: insErr } = await sb.from("dept_versions").insert({
    dept,
    version: nextVersion,
    html: newHtml,
    change_summary: edits.summary,
    change_log: { applied, skipped },
    sources: {
      feedback_ids: inputs.feedback.map((f) => f.id),
      conversation_ids: inputs.transcripts.map((t) => t.id),
      document_ids: inputs.documents.map((d) => d.id),
    },
    created_by: createdBy || null,
  });
  if (insErr) throw insErr;

  // Stamp the shared documents this version folded in.
  try {
    await docsLib.markFolded(inputs.documents.map((d) => d.id), nextVersion);
  } catch (err) {
    console.error(`[versions] markFolded failed:`, err?.message || err);
  }

  // Refresh this dept's knowledge base from the new version.
  try {
    await reseedKb(dept, nextVersion, newHtml);
  } catch (err) {
    console.error(`[versions] KB reseed failed for ${dept} v${nextVersion}:`, err?.message || err);
  }

  // Refresh this function's long-term memory with the new state (best-effort).
  try {
    const memory = await import("./memory.js");
    await memory.rebuild(dept);
  } catch (err) {
    console.error(`[versions] memory rebuild failed:`, err?.message || err);
  }

  return {
    dept,
    version: nextVersion,
    summary: edits.summary,
    applied: applied.length,
    skipped: skipped.length,
    usage: { input_tokens: usage?.input_tokens, output_tokens: usage?.output_tokens },
  };
}

// ---------------------------------------------------------------------------
// Agent Mode — operator-directed drafts (Sne/Raj). Propose → preview → refine →
// approve (publishes as the next version) or discard. Gated by the same
// VERSION_ACCESS_CODE as generation.
// ---------------------------------------------------------------------------

const DRAFT_START = "<!--KEE-DRAFT-BANNER-START-->";
const DRAFT_END = "<!--KEE-DRAFT-BANNER-END-->";
const stripDraftBanner = (html) =>
  html.replace(new RegExp(`${DRAFT_START}[\\s\\S]*?${DRAFT_END}\\n?`), "");

function checkAccess(accessCode) {
  const required = process.env.VERSION_ACCESS_CODE;
  if (!required) { const e = new Error("Agent Mode is not configured (set VERSION_ACCESS_CODE)"); e.code = "not_configured"; throw e; }
  if (accessCode !== required) { const e = new Error("Invalid access code"); e.code = "bad_access_code"; throw e; }
  if (!llmConfigured()) { const e = new Error("Agent Mode is not configured (set OPENROUTER_API_KEY)"); e.code = "not_configured"; throw e; }
}

const OPERATOR_SYSTEM = `You are the document editor behind "Covalent Kee", working in Agent Mode: a KeeMakr operator gives you a direct instruction describing changes to one of Covalent's operating-system documents, and you produce minimal, surgical find/replace edits that carry it out. The result is a DRAFT the operator reviews before publishing.

Rules:
- Follow the operator's instruction faithfully. If parts of it are ambiguous, make the most reasonable interpretation and explain your choice in the change reasons.
- "find" must be an EXACT verbatim substring of the file it targets — copy it character-for-character including whitespace, entities (&amp;), and punctuation. 40-400 characters, long enough to be unique.
- Keep edits surgical: change text and values, not structure. Never edit CSS, never change JavaScript logic — only the human-readable text inside markup or inside JS string literals.
- When the text you are changing is visible HTML body text, wrap the changed phrase in the replacement with: <mark class="kee-rev" title="REASON">changed text</mark> (REASON under 120 chars, no double quotes inside).
- When the text lives inside a JavaScript string literal or an HTML attribute, do NOT add any markup — plain text only, preserve the original quoting and escaping exactly.
- For each change, "source" should be "Agent Mode — <operator name>".
- If the instruction asks for something you cannot do with text edits (layout overhauls, new pages), do what is possible and say what was skipped in the summary.`;

function draftBanner(dept, baseVersion, summary, applied, instructions) {
  const items = applied
    .map((a) => `<li><span>${esc(a.reason)}</span> <em>${esc(a.source)}</em></li>`)
    .join("");
  const asks = (instructions || [])
    .map((i) => `<li>"${esc(i.text)}" — ${esc(i.by || "operator")}</li>`)
    .join("");
  return `${DRAFT_START}
<div class="kee-changelog" id="keeDraftBanner" style="border-left-color:#534ab7;background:#f4f3fd;border-color:#ddd9f5">
  <style>
    .kee-changelog{font-family:'Spline Sans','Inter Tight',system-ui,sans-serif;border:1px solid #ddd9f5;border-left:4px solid #534ab7;border-radius:0 12px 12px 0;padding:14px 18px;margin:0 auto 26px;max-width:880px;color:#37335c;font-size:13.5px;line-height:1.55}
    .kee-changelog .kc-hd{display:flex;align-items:center;gap:8px;font-weight:600;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#534ab7;margin-bottom:7px}
    .kee-changelog .kc-badge{background:#534ab7;color:#fff;border-radius:10px;padding:1px 9px;font-size:11px;letter-spacing:.04em}
    .kee-changelog ul{margin:8px 0 0;padding-left:18px}
    .kee-changelog li{margin:3px 0}
    .kee-changelog li em{color:#8a86a8;font-style:normal;font-size:12px}
    .kee-changelog .kc-src{margin-top:8px;font-size:12px;color:#8a86a8}
    mark.kee-rev{background:#e3e0fb;border-bottom:2px solid #534ab7;border-radius:3px;padding:0 2px;cursor:help}
  </style>
  <div class="kc-hd"><span class="kc-badge">DRAFT</span> Proposed changes — not yet published (base: v${baseVersion})</div>
  <div>${esc(summary)}</div>
  ${asks ? `<div class="kc-src" style="margin-top:8px"><b>Operator instructions:</b><ul>${asks}</ul></div>` : ""}
  ${items ? `<ul>${items}</ul>` : ""}
  <div class="kc-src">This draft is only visible in Agent Mode. Approve it to publish as v${baseVersion + 1}, or discard it.</div>
</div>
${DRAFT_END}`;
}

export async function getDraft(dept) {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from("dept_drafts")
    .select("id, dept, base_version, html, change_summary, change_log, instructions, created_by, status, created_at, updated_at")
    .eq("dept", dept)
    .eq("status", "draft")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

export async function proposeDraft({ dept, instruction, accessCode, createdBy }) {
  checkAccess(accessCode);
  if (!DEPTS.includes(dept)) { const e = new Error(`Unknown dept "${dept}"`); e.code = "bad_dept"; throw e; }
  const ask = String(instruction || "").trim();
  if (!ask) { const e = new Error("Tell the agent what to change"); e.code = "bad_instruction"; throw e; }

  const sb = requireSupabase();
  const active = await getDraft(dept);
  let baseHtml, baseVersion;
  if (active) {
    baseHtml = stripDraftBanner(active.html);
    baseVersion = active.base_version;
  } else {
    const current = await getVersion(dept);
    if (!current) { const e = new Error("No current document for this function"); e.code = "no_document"; throw e; }
    baseHtml = current.html;
    baseVersion = current.version || 1;
  }

  const files = explodeFiles(baseHtml);
  const parts = [
    `Function: ${DEPT_NAMES[dept]} (dept key: ${dept}). Draft based on published v${baseVersion}.`,
    `\n=== OPERATOR INSTRUCTION (from ${createdBy || "a KeeMakr operator"}) ===\n${ask}`,
    `\n=== CURRENT DOCUMENT ===`,
  ];
  for (const [name, content] of Object.entries(files)) {
    if (name === "__blob") continue;
    parts.push(`\n<<<FILE ${name}>>>\n${content}\n<<<END FILE ${name}>>>`);
  }
  parts.push(`\nProduce the edits now.`);

  const start = Date.now();
  const { text: genText, usage } = await generate({
    model: MODEL,
    system: OPERATOR_SYSTEM,
    content: parts.join("\n"),
    schema: EDITS_SCHEMA,
    maxTokens: 32000,
  });
  captureGeneration({
    model: MODEL,
    input: [{ role: "system", content: OPERATOR_SYSTEM }, { role: "user", content: parts.join("\n") }],
    output: genText || "",
    usage,
    latencyMs: Date.now() - start,
    distinctId: createdBy || "server",
    properties: { feature: "draft_propose", dept, version: baseVersion + 1 },
  });
  let edits;
  try { edits = JSON.parse(genText || "{}"); }
  catch { const e = new Error("The agent returned an unparseable result — try again."); e.code = "bad_model_output"; throw e; }

  const { applied, skipped } = applyEdits(files, edits.changes, baseVersion + 1);
  const cleanHtml = implodeFiles(files);

  const priorApplied = active?.change_log?.applied || [];
  const allApplied = [...priorApplied, ...applied];
  const instructions = [...(active?.instructions || []), { by: createdBy || null, text: ask, at: new Date().toISOString() }];
  const summary = active?.change_summary
    ? `${active.change_summary} ${edits.summary || ""}`.trim()
    : (edits.summary || "");

  const draftHtml = injectBanner(cleanHtml, draftBanner(dept, baseVersion, summary, allApplied, instructions));

  const row = {
    dept,
    base_version: baseVersion,
    html: draftHtml,
    change_summary: summary,
    change_log: { applied: allApplied, skipped },
    instructions,
    created_by: active?.created_by || createdBy || null,
    status: "draft",
    updated_at: new Date().toISOString(),
  };
  let draftId = active?.id;
  if (active) {
    const { error } = await sb.from("dept_drafts").update(row).eq("id", active.id);
    if (error) throw error;
  } else {
    const { data, error } = await sb.from("dept_drafts").insert(row).select("id").single();
    if (error) throw error;
    draftId = data.id;
  }

  return {
    dept, draft_id: draftId, base_version: baseVersion,
    summary: edits.summary, applied: applied.length, skipped: skipped.length,
    total_changes: allApplied.length, html: draftHtml,
    usage: { input_tokens: usage?.input_tokens, output_tokens: usage?.output_tokens },
  };
}

export async function approveDraft({ dept, accessCode, createdBy }) {
  checkAccess(accessCode);
  const sb = requireSupabase();
  const draft = await getDraft(dept);
  if (!draft) { const e = new Error("No draft to approve for this function"); e.code = "no_draft"; throw e; }

  const current = await getVersion(dept);
  const nextVersion = (current?.version || draft.base_version) + 1;

  // Publish: swap the draft banner for the standard version changelog.
  const applied = draft.change_log?.applied || [];
  const banner = changelogBanner(nextVersion, draft.change_summary || "Operator-directed update.", applied,
    { feedback: [], transcripts: [] });
  const finalBanner = banner.replace(
    /Generated by Covalent Kee from[^<]*/,
    `Directed in Agent Mode by ${esc(draft.created_by || createdBy || "the KeeMakr team")} and approved by ${esc(createdBy || "the operator")}. `
  );
  const html = injectBanner(stripDraftBanner(draft.html).replace(/<div class="kee-changelog" id="keeDraftBanner"[\s\S]*?<\/div>\n?/, ""), finalBanner);

  if (current?.seed) {
    await sb.from("dept_versions").insert({
      dept, version: 1, html: current.html, change_summary: "Original artifact", created_by: null,
    });
  }
  const { error: insErr } = await sb.from("dept_versions").insert({
    dept,
    version: nextVersion,
    html,
    change_summary: draft.change_summary,
    change_log: draft.change_log,
    sources: { agent_mode: true, instructions: draft.instructions },
    created_by: createdBy || draft.created_by || null,
  });
  if (insErr) throw insErr;

  await sb.from("dept_drafts").update({ status: "published", updated_at: new Date().toISOString() }).eq("id", draft.id);

  try { await reseedKb(dept, nextVersion, html); }
  catch (err) { console.error(`[agent-mode] KB reseed failed:`, err?.message || err); }
  try { const memory = await import("./memory.js"); await memory.rebuild(dept); }
  catch (err) { console.error(`[agent-mode] memory rebuild failed:`, err?.message || err); }

  return { dept, version: nextVersion, summary: draft.change_summary, changes: applied.length };
}

// Publish an externally-authored HTML document as the dept's next version.
// Unlike generate/agent-mode, the HTML is supplied wholesale (e.g. a doc built
// outside the app and re-skinned to our palette). Mirrors approveDraft's
// seed-preservation, KB reseed and memory rebuild. Access-code gated; no LLM.
export async function publishHtml({ dept, accessCode, html, summary, createdBy }) {
  const required = process.env.VERSION_ACCESS_CODE;
  if (!required) { const e = new Error("Publishing is not configured (set VERSION_ACCESS_CODE)"); e.code = "not_configured"; throw e; }
  if (accessCode !== required) { const e = new Error("Invalid access code"); e.code = "bad_access_code"; throw e; }
  if (!DEPTS.includes(dept)) { const e = new Error(`Unknown dept "${dept}"`); e.code = "bad_dept"; throw e; }
  if (!html || typeof html !== "string" || html.length < 200) { const e = new Error("html is required"); e.code = "bad_html"; throw e; }

  const sb = requireSupabase();
  const current = await getVersion(dept);
  const nextVersion = (current?.version || 1) + 1;

  // Preserve the original artifact as v1 the first time we publish over a seed.
  if (current?.seed) {
    await sb.from("dept_versions").insert({
      dept, version: 1, html: current.html, change_summary: "Original artifact", created_by: null,
    });
  }

  const { error: insErr } = await sb.from("dept_versions").insert({
    dept,
    version: nextVersion,
    html,
    change_summary: summary || "Published from an externally-authored document.",
    sources: { published: true },
    created_by: createdBy || null,
  });
  if (insErr) throw insErr;

  try { await reseedKb(dept, nextVersion, html); }
  catch (err) { console.error(`[publish] KB reseed failed:`, err?.message || err); }
  try { const memory = await import("./memory.js"); await memory.rebuild(dept); }
  catch (err) { console.error(`[publish] memory rebuild failed:`, err?.message || err); }

  return { dept, version: nextVersion, summary: summary || null };
}

export async function discardDraft({ dept, accessCode }) {
  checkAccess(accessCode);
  const sb = requireSupabase();
  const draft = await getDraft(dept);
  if (!draft) { const e = new Error("No draft to discard"); e.code = "no_draft"; throw e; }
  const { error } = await sb.from("dept_drafts").update({ status: "discarded", updated_at: new Date().toISOString() }).eq("id", draft.id);
  if (error) throw error;
  return { discarded: true };
}

// Replace the dept's auto-managed KB doc (seed/version) with one built from
// the given html. Manually ingested docs (source 'paste' etc.) are untouched.
export async function reseedKb(dept, version, html) {
  const sb = requireSupabase();
  const { data: old } = await sb
    .from("kb_documents")
    .select("id")
    .eq("dept", dept)
    .in("source", ["seed", "version"]);
  for (const d of old || []) {
    await sb.from("kb_documents").delete().eq("id", d.id);
  }
  const text = htmlToText(html);
  if (!text) return;
  await kb.ingest({
    title: `${DEPT_NAMES[dept]} — v${version}`,
    text,
    source: "version",
    dept,
  });
}
