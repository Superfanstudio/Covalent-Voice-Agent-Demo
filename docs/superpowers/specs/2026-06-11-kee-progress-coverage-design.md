# Kee progress-aware, open-areas-only interviews — design

**Date:** 2026-06-11
**Status:** approved (build fixed-rubric backbone now; emergent layer is a later drop-in)

## Goal

When a caller starts Covalent Kee on a function tab, Kee should:
1. Open with a spoken progress summary — e.g. "On the ICP model we're about 70 percent there."
2. State the **open areas** (team-level: what no one has covered yet for this function).
3. Ask **only the open areas**, in order — never restart at the same first question every call.

Self-improving loop: each call → transcript → workbook memory (existing `updateAfterConversation`) → next call's coverage recomputes → open list shrinks → Kee targets the gaps. At ~100% she invites enrichment instead of re-interviewing.

## Decisions

- **Coverage computed by our Claude (Fable)** before each call — reliable %, deterministic skip list. Not self-assessed by the in-call (AssemblyAI) model.
- **Team-level** coverage — the workbook memory is global, so "70%" is collective progress on that function.
- **Fixed 6-area rubric** drives % and skip logic (stable, interpretable denominator). Emergent themes are explicitly OUT of v1 (would destabilize the %); they slot in later as a capped `emergent[]` field that does NOT affect %.

## Components

### A. Area rubric — `personas.js`
Add `areas: [{ id, label, prompt }]` (6 per real dept: icp, ihp, sales, marcom, hr, supply), derived verbatim-in-spirit from each persona's existing "six questions". `guide` has none. No change to question wording.

### B. Coverage — `lib/coverage.js` (new) + route in `lib/router.js`
`GET /api/coverage?dept=X` → `assessCoverage(dept)`:
- Loads global workbook memory + dept's `areas`.
- Calls Fable (`MEMORY_MODEL`) with structured output (`output_config` json_schema):
  `{ percent:int, covered:[id], open:[id], opener:string }`.
- `opener` is spoken-friendly (no markdown, numbers spelled out) per the persona voice rules.
- Empty/no memory → `{ percent:0, covered:[], open:[all ids], opener:"just getting started…" }`.
- Best-effort: throws `not_configured` (503) if no Anthropic/Supabase; never crashes.

### C. Call wiring — `index.html` `startCall`
- Fetch `/api/coverage?dept=callDept` in parallel with `/api/memory`.
- On success: set AssemblyAI `greeting = coverage.opener`; append a COVERAGE block to the system prompt:
  `COVERED (do not re-ask): …. OPEN (ask ONLY these, in order): …. Override the question list above accordingly. If all covered, thank + invite additions.`
- On failure/timeout (~4s): fall back to `persona.greeting` + today's behavior. Never blocks the call.

### D. UI status chip (minor)
Small line in the Kee panel sub-header: `ICP · 70% covered · 2 open`. Reinforces the spoken summary. Updated from the coverage response.

## Fallbacks / safety
- Coverage is a best-effort side effect; any failure → normal call (persona greeting, all 6 in order).
- No schema/DB changes. Reuses existing memory pipeline and Claude conventions (streaming + `finalMessage`, structured outputs, `claude-fable-5`).

## Out of scope (v1)
- Emergent open areas (later: add `emergent[]` to the schema + one instruction; does not affect %).
- Per-caller coverage, persisted per-question coverage tables.
