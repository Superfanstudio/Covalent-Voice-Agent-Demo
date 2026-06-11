// Team-level coverage assessment for a function's discovery areas.
//
// Reads the global workbook memory and decides, per fixed area (personas.js
// AREAS), whether it has been substantively covered yet across the team — so a
// voice call can open with a progress summary and ask ONLY the open areas
// instead of restarting the same questions every time. The percentage is always
// over the fixed area set, so it stays stable and interpretable.
//
// Best-effort: callers treat any throw as "fall back to the normal interview".
import "./env.js";
import { AREAS } from "../personas.js";
import { getMemory } from "./memory.js";
import { DEPT_NAMES } from "./versions.js";
import { captureGeneration } from "./posthog.js";
import { generate, llmConfigured } from "./llm.js";

const MEMORY_MODEL = process.env.MEMORY_MODEL || "claude-fable-5";

const COVERAGE_SCHEMA = {
  type: "object",
  properties: {
    covered: { type: "array", items: { type: "string" }, description: "Area ids substantively answered in the memory for this function." },
    open: { type: "array", items: { type: "string" }, description: "Area ids not yet covered." },
    opener: { type: "string", description: "One or two SPOKEN sentences Kee says first: state the rough percent covered (spell out numbers), name the open areas in plain words, then transition into the first open area. No markdown, no lists." },
  },
  required: ["covered", "open", "opener"],
  additionalProperties: false,
};

// assessCoverage(dept) -> { percent, covered:[{id,label}], open:[{id,label}], opener }
export async function assessCoverage(dept) {
  const areas = AREAS[dept];
  if (!areas) { const e = new Error(`No coverage areas for "${dept}"`); e.code = "bad_dept"; throw e; }
  if (!llmConfigured()) { const e = new Error("OpenRouter API key is not set"); e.code = "not_configured"; throw e; }

  const allIds = areas.map((a) => a.id);
  const byId = Object.fromEntries(areas.map((a) => [a.id, a.label]));
  const fn = DEPT_NAMES[dept] || dept;

  // No memory yet → nothing covered; start fresh.
  let memText = "";
  try { memText = (await getMemory(dept))?.content || ""; } catch { /* memory optional */ }
  if (!memText.trim()) {
    return {
      percent: 0,
      covered: [],
      open: areas.map((a) => ({ id: a.id, label: a.label })),
      opener: `Hi — I'm Covalent Kee. We're just getting started on the ${fn.toLowerCase()}, so there's plenty to cover. Let's dive in.`,
    };
  }

  const areaList = areas.map((a) => `- ${a.id}: ${a.label} — ${a.prompt}`).join("\n");
  const system = `You assess how complete a team's discovery is for ONE function of Covalent's operating model. You receive the running WORKBOOK MEMORY (everything captured so far across all calls, feedback, and documents) and a fixed list of discovery AREAS for the "${fn}" function. For EACH area decide if it has been substantively addressed anywhere in the memory for THIS function — a real answer or a clear position, not merely mentioned in passing. Return the covered and open area ids and a short spoken opener for the voice interviewer.`;
  const user = `# FUNCTION\n${fn}\n\n# AREAS (id: label — meaning)\n${areaList}\n\n# WORKBOOK MEMORY\n${memText.slice(0, 60000)}\n\nAssess coverage for the ${fn} areas only. The opener must be spoken-friendly: one or two sentences, state the rough percentage covered (spell numbers out, e.g. "about seventy percent"), name the open areas in plain words, then transition into the first open area. If everything is covered, the opener thanks them and invites any final additions rather than re-interviewing.`;

  const start = Date.now();
  const { text: raw, usage } = await generate({
    model: MEMORY_MODEL,
    system,
    content: user,
    schema: COVERAGE_SCHEMA,
    maxTokens: 3000,
  });
  let parsed;
  try { parsed = JSON.parse(raw || "{}"); }
  catch { const e = new Error("Coverage model returned unparseable output"); e.code = "bad_model_output"; throw e; }

  // Trust only ids in the rubric; derive open + percent from the fixed set.
  const coveredIds = [...new Set((parsed.covered || []).filter((id) => allIds.includes(id)))];
  const openIds = allIds.filter((id) => !coveredIds.includes(id));
  const percent = Math.round((coveredIds.length / allIds.length) * 100);

  captureGeneration({
    model: MEMORY_MODEL,
    input: [{ role: "system", content: system }, { role: "user", content: user }],
    output: raw,
    usage,
    latencyMs: Date.now() - start,
    properties: { feature: "coverage_assess", dept, percent },
  });

  return {
    percent,
    covered: coveredIds.map((id) => ({ id, label: byId[id] })),
    open: openIds.map((id) => ({ id, label: byId[id] })),
    opener: (parsed.opener || "").trim(),
  };
}
