# Covalent Operating System — Living Discovery Workbook

A voice-first, self-updating discovery workbook for **Covalent** (AI-first North-America aesthetics distribution), built by **KeeMakr**. Eight living sections — the **Activation Roadmap** (the landing page) and **Tool Selection** up top, plus six operating-model documents (Ops — Supply Chain & Logistics, ICP & Persona Discovery, Ideal Hiring Profile, Sales, Marketing, HR) — that the team's input continuously reshapes: every feedback comment, voice interview with the AI agent ("Covalent Kee"), and shared source document feeds the next published version of each section. Placeholder "Up Next" sections (Finance; Legal, Compliance & Governance; FDA/Regulatory; R&D) stage the functions discovery hasn't reached yet.

**Live:** https://covalent-kee.vercel.app · `/demo` (original v1 voice demo, unlinked) · `/admin` (operator console, unlinked) · `/api/health` (readiness check)

> Vercel project `covalent-voice-agent-demo` under the **fsztpartners** team. The `*-fsztpartners.vercel.app` aliases sit behind Vercel deployment protection (401) — share the `covalent-kee` domain.

---

## Features

| Feature | What it does |
|---|---|
| **Eight living documents** | Each section is a full HTML page, versioned in Supabase (`dept_versions`). Version dropdown per section, plus a **History** panel (button beside the dropdown) listing what changed in each version and who drove it — the per-edit changelog lives there, lifted off the top of the page; edits inside the document stay highlighted inline. Every operating-model section opens with a compact **activation-timeline strip** (its own confirm → Covalent Kee activation → hires → launch bars), and high-signal sections carry a **discovery roll-up** ("what we now know → how it configures the agents → where the human gates sit" — see ICP/IHP). |
| **Tool Selection strategy** | Three-tier ladder per category: 1) KeeMakr builds AI-first, 2) KeeMakr + existing AI-native tools, 3) + proven SaaS — with contender chips, statuses (ERP: 3 AI-native finalists shortlisted), CTU as the only learning platform, and Work-OS basics (email suite, comms, Notion, e-sign, AI Notetaker = KeeMakr). |
| **Covalent Kee (voice agent)** | AssemblyAI Voice Agent with a per-function discovery persona (six questions, ~5 min). She gets the live page text, a dept-scoped knowledge base tool, and that function's memory injected into every call. Green FAB, bottom of every section. |
| **Progress-aware interviews (coverage)** | Before each call, Fable scores the team's progress against a fixed 6-area rubric per function (`AREAS` in personas.js). Kee opens with "we're about seventy percent there", skips covered areas, and asks **only the open ones**. Design doc: `docs/superpowers/specs/`. |
| **Feedback** | Per-function comments (browser → Supabase REST with the publishable key). Contributors appear in "Shaped by" chips on the sections they've touched. |
| **Version generation** | "✦ New version" (access-code gated) has Claude fold all feedback + transcripts + shared documents since the last version into the document as surgical find/replace edits, with `<mark>` highlights and a changelog. KB re-seeds and memory rebuilds automatically. |
| **Documents** | Upload Word/PDF/text/markdown/images (≤4MB), attributed to a sharer. Raw file stored in Supabase Storage (`shared-docs` bucket), text extracted client-side into the KB, images sent to Claude as vision inputs at generation time. Optional "fold into a new version now". Deleting a document also removes its knowledge-base entry (the KB copy is tagged `upload:<doc_id>`), so Kee stops retrieving content the contributor has removed. |
| **Finance simulator & scenarios** | The Finance section hosts an interactive **AI-Native Org Simulator** (`finance-sim.html`) instead of a versioned doc. A start screen offers the **base template** or anyone's **saved scenario**; open one, tweak the sliders, and **save your own version** (attributed to you, forked via `based_on`). A selector switches between everyone's versions. Scenarios live in `sim_scenarios`; the shell ↔ simulator talk over postMessage. |
| **Agent Mode** | Operator console (KeeMakr: Sne/Raj/Krutin). Plain-language instruction → Claude stages a **draft** (purple banner, private), preview in place, refine cumulatively, then Approve & publish as the next version — or Discard. |
| **Function memory ("AI brain")** | One living memory document **per function** (keyed by dept in `agent_memory`), maintained by Claude Fable (1M context) from that function's transcripts, feedback, documents, and versions. Updated incrementally after every call, rebuilt after every publish. Injected into that function's voice sessions — ICP calls never see Sales history. |
| **Activity Log & Conversations** | Unified timeline (comments, calls, document shares, publishes) + contributor leaderboard, plus an in-app Conversations panel for reading transcripts. |
| **How-to-use guide** | `?` buttons (version bar, mobile topbar, sidebar footer) open a written quick guide + optional voice tour by Kee. |
| **Identity** | First-load name picker (preset team names + custom), stored locally, married to the PostHog device ID so one person = one profile across devices. |
| **Print / Save PDF** | Prints whichever version of a function is on screen (descends into the Sales workshop's nested iframe). |

---

## Architecture

```
Browser (vanilla JS, no build step)
│
├── index.html ─ the OS shell: sidebar, versioned iframes, voice widget,
│                feedback drawer, agent-mode drawer, documents tab, activity log
│   ├─ voice: mic → AudioWorklet PCM16 → wss://agents.assemblyai.com (STT+LLM+TTS)
│   │         tool calls (KB search) round-trip through our API
│   └─ feedback: direct Supabase REST (publishable key, RLS-policied table)
│
├── /api/token        → mints single-use AssemblyAI tokens (key stays server-side)
└── /api/*            → api/router.js → lib/router.js  (one framework-agnostic router
                        shared by Vercel functions and the local node server)
        │
        ├── lib/versions.js   versions + generation + Agent Mode drafts (Claude Opus)
        ├── lib/memory.js     per-function memory (Claude Fable, 1M context)
        ├── lib/coverage.js   discovery-progress scoring per function (Fable)
        ├── lib/llm.js        ALL Claude calls, via OpenRouter (Chat Completions)
        ├── lib/docs.js       shared documents (Supabase Storage + KB ingest)
        ├── lib/kb.js         chunking + Postgres full-text search (no pgvector)
        ├── lib/conversations.js  transcripts
        ├── lib/activity.js   unified activity feed
        ├── lib/posthog.js    event capture + LLM analytics (@posthog/ai)
        └── lib/supabase.js   service-role client (server only)
```

**Stack:** vanilla HTML/JS (zero build), Node 18+ (`node:http` locally, Vercel functions in prod), Supabase (Postgres + Storage), AssemblyAI Voice Agents, Claude models via **OpenRouter** (`lib/llm.js` — no Anthropic SDK), PostHog (incl. LLM generation analytics).

---

## Project structure

```
index.html            The Operating System shell (main page). All shell UI + voice engine.
demo.html             Original v1 two-agent voice demo — still served at /demo on Vercel, unlinked from the nav.
admin.html            Admin console (transcripts, KB management, seeding) — served at /admin on Vercel, unlinked.
personas.js           Kee's voice personas (6 interviewers + how-to guide) + AREAS coverage rubric.
finance-sim.html      The Finance AI-Native Org Simulator (interactive tool). Served static; hosted in the Finance section's iframe. Talks to the shell over postMessage (get/apply scenario state).
docs/                 Design decisions/specs (e.g. the coverage feature).
server.js             Local dev server (mirrors Vercel routing exactly).
vercel.json           Rewrites (/admin, /demo, /api/:path* → /api/router) + 300s maxDuration.
data/depts.json       v1 seed payload: base64 HTML per section — 8 keys incl. overview + tools (offline fallback too).
api/
  token.js            AssemblyAI token minting (filesystem precedence over the rewrite).
  router.js           Catch-all Vercel function → lib/router.js.
lib/
  router.js           ALL /api/* endpoint logic. Start here to trace any request.
  llm.js              Single LLM entry point — Claude via OpenRouter (model slugs, schema output, vision).
  versions.js         Version read/list, Claude generation, Agent Mode draft lifecycle.
  memory.js           Per-function memory: incremental update + full rebuild (Fable).
  coverage.js         Team-level coverage vs the AREAS rubric → percent + open areas + spoken opener.
  scenarios.js        Saved simulator scenarios (list/get/create) — the Finance simulator's per-contributor versions.
  docs.js             Document upload/list/delete/download, Storage bucket, fold tracking. Upload ingests text into the KB tagged `upload:<doc_id>`; delete removes that KB entry too.
  kb.js               Chunking (~800 chars) + ingest + search_kb RPC.
  conversations.js    Conversation/turn persistence + reapStale (end calls stranded in `live`, for the sweep endpoint).
  activity.js         Activity feed aggregation (public-safe: no transcript text).
  extract.js          HTML → plain text (handles JS-rendered sections + nested base64 blobs).
  supabase.js         Service-role client; NotConfigured error type.
  posthog.js          Server-side capture + public browser config.
  env.js              .env loader (local dev only; no dotenv dependency).
supabase/schema.sql   Full idempotent schema (already applied to the live project).
```

**Branches:** `main` = this app. `v1` = the original standalone voice demo, frozen.

---

## Data model (Supabase project `wxividqrrmsbuaxncpsn` / "covalent-feedback")

| Table | Purpose | Written by |
|---|---|---|
| `covalent_feedback` | Per-function comments | **Browser directly** (publishable key + RLS policies) |
| `conversations` / `turns` | Voice-call transcripts (dept, user_name, doc_version) | Server (service role) |
| `kb_documents` / `kb_chunks` | Knowledge base; `search_kb(q, k, dept_filter)` FTS function | Server |
| `dept_versions` | Full HTML snapshot per published version per function | Server |
| `dept_drafts` | Agent Mode drafts (draft → published/discarded) | Server |
| `shared_documents` | Uploaded source docs (raw file in `shared-docs` Storage bucket) | Server |
| `agent_memory` | One living memory document per function (`id` = dept key) | Server (Claude Fable) |
| `sim_scenarios` | Saved simulator runs (`tool`, `name`, `created_by`, `based_on` fork lineage, `state` jsonb) — powers the Finance simulator's "open someone's version, tweak, save your own" | Server |

Dept keys everywhere: `overview` (Activation Roadmap) · `tools` (Tool Selection) · `supply` (Ops — Supply Chain & Logistics) · `icp` · `ihp` · `sales` · `marcom` (Marketing) · `hr`. Product naming: always "Covalent Kee", never bare "Kee"; "Marketing", never "Marcom".

---

## API (all JSON; defined in `lib/router.js`)

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health` | — | Which env keys are set, schema reachability, readiness hint |
| `GET /api/config` | — | Public browser config (PostHog token) |
| `GET /api/token` | — | Single-use AssemblyAI voice token |
| `GET /api/versions?dept=` · `GET /api/versions/current?dept=&v=` | — | Version list / full HTML |
| `POST /api/versions/generate` | access code | Fold inputs into a new version (Claude) |
| `POST /api/versions/publish` | access code | Publish an externally-authored HTML doc as the next version (preserves the seed as v1, reseeds KB + memory). For docs built outside the app. Body: `{dept, html, summary?, created_by?}` |
| `GET /api/draft?dept=` (header `x-access-code`) | access code | Active Agent Mode draft |
| `POST /api/draft/propose` · `/approve` · `/discard` | access code | Draft lifecycle |
| `GET/POST/DELETE /api/docs` | — | List (signed URLs) / upload / delete shared documents |
| `GET /api/memory?dept=` · `POST /api/memory/refresh {dept?}` | — / access code | Read / rebuild a function's memory (no dept = rebuild all) |
| `GET /api/coverage?dept=` | — | Discovery progress: percent, covered/open areas, spoken opener |
| `POST /api/kb/search` | — | Dept-scoped FTS (the voice agent's tool) |
| `GET /api/kb/docs` | — | KB document list |
| `POST /api/kb/ingest` · `DELETE /api/kb/docs` · `POST /api/kb/seed` | admin | KB management |
| `POST /api/conversations` · `POST /api/turns` · `PATCH /api/conversations/:id` | — | Call persistence (call-end also triggers a memory update). The browser sends call-end via `sendBeacon`/`pagehide` so it survives a tab close mid-call. |
| `POST /api/conversations/sweep` | admin | End conversations stranded in `live` (call-end never arrived) and fold each into memory — safety net for the fire-and-forget end request; idempotent, cron-safe. Body: `{max_age_min?}` (default 30). |
| `GET /api/conversations[/:id]` · `DELETE /api/conversations/:id` | — (open) | Transcript review / delete — powers the in-app Conversations panel; consider gating before wide rollout |
| `GET /api/activity` | — | Activity feed + contributor tallies |
| `GET /api/scenarios?tool=` · `GET /api/scenarios/:id` · `POST /api/scenarios` | — | Saved simulator scenarios: list (lightweight) / one (full state) / save a version. Body: `{tool, name, created_by, based_on?, state}` |

Auth modes: **admin** = `x-admin-password` header vs `ADMIN_PASSWORD` env (open when unset, e.g. localhost). **access code** = `access_code` in body (or `x-access-code` header) vs `VERSION_ACCESS_CODE` env — never hardcoded in the repo.

## Environment

See [.env.example](.env.example). Required for full function: `ASSEMBLYAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, `VERSION_ACCESS_CODE`. Optional: `ADMIN_PASSWORD`, `POSTHOG_PROJECT_TOKEN`, `ANTHROPIC_MODEL` (default `claude-opus-4-8`), `MEMORY_MODEL` (default `claude-fable-5`). Check `GET /api/health` after changes.

## Local development

```sh
npm install
cp .env.example .env   # fill in keys
npm run dev            # http://localhost:3000  (/demo, /admin)
```

No build step — edit files, reload the browser. **Restart the server after editing `lib/`** (ESM module cache). The schema is already applied to the live Supabase project; for a fresh project run `supabase/schema.sql` once, then click "Seed from documents" in `/admin` → Knowledge Base.

## Deployment

Pushing to `main` auto-deploys on Vercel. Gotchas learned the hard way:

- **Nested `/api/*` paths need the `vercel.json` rewrite** (`/api/:path* → /api/router?p=:path*`). Bracket catch-all files (`api/[...path].js`) silently fail to match multi-segment paths on this project — don't reintroduce them.
- `maxDuration: 300` is required: version generation and memory rebuilds run 1–3 minutes.
- Request bodies cap at ~4.5MB on Vercel → document uploads are limited to 4MB (base64 in JSON).
- **A fire-and-forget request that has a server-side side effect must survive the page being torn down.** Call-end (`POST /api/conversations/:id`) folds the transcript into memory, so a plain `fetch` that dies when the tab closes leaves the call stranded in `live` and the memory never updates. Use `navigator.sendBeacon` (+ `keepalive` fetch fallback) fired on `pagehide`, and back it with a server-side reaper (`POST /api/conversations/sweep`, cron-safe) for the ones that still slip through. Apply the same pattern to any future "on close, persist X" path.
- **Anything ingested into the KB must be removable by the same handle that created it.** Derived KB copies (document uploads) are tagged `source = upload:<doc_id>` so deleting the source document also deletes its KB rows — otherwise Kee keeps reciting content the contributor removed. Always tag a derived KB row with a stable link back to its source. (Legacy rows tagged plain `upload` predate this and won't auto-clean on delete.)

---

## Key flows (for humans and AI agents)

**Voice call:** `startCall()` in index.html → `/api/token` → WebSocket to AssemblyAI → `session.update` carries: persona system prompt (personas.js) + KB tool + that function's memory (`/api/memory?dept=`, ≤18k chars) + coverage block (`/api/coverage?dept=` — opener greeting + "ask only these open areas") + live page text (recursive iframe `innerText`). Coverage/memory are best-effort: any failure falls back to the plain persona interview. Turns persist fire-and-forget; call-end (`POST /api/conversations/:id`) triggers an incremental memory update server-side. The client sends call-end via `navigator.sendBeacon` (with a `keepalive` fetch fallback) and on `pagehide`, so a call that ends by closing the tab still records its final status and folds into memory instead of stranding in `live`. `POST /api/conversations/sweep` reaps any that still slip through (and can be run on a cron).

**Version generation** (`lib/versions.js: generateVersion`): gather feedback + transcripts + documents since last version → Claude returns structured find/replace edits (JSON schema output) → applied literally (`indexOf`), visible changes wrapped in `<mark class="kee-rev">` → changelog banner injected → new `dept_versions` row → docs stamped `version_folded` → KB re-seed → memory rebuild. The Sales section nests sub-pages as base64 inside a JSON blob; `explodeFiles/implodeFiles` lets Claude patch inside them.

**Agent Mode** (`lib/versions.js: proposeDraft/approveDraft/discardDraft`): same edit machinery, driven by an operator instruction instead of accumulated inputs. Drafts live in `dept_drafts` with a purple banner; approve strips it, injects the standard changelog, and publishes as the next version.

**Graceful degradation:** every feature checks for its dependencies and falls back — sections render from `data/depts.json` without Supabase, feedback/contributors work with just the publishable key, voice works with just AssemblyAI, and version/memory/docs features return clear 503s with `code` fields until configured.

### Conventions (read before building on top)

1. **One router.** Every `/api/*` endpoint lives in `lib/router.js` and must work identically under `server.js` and Vercel. Never put logic in `api/*.js` beyond request normalization.
2. **No frameworks, no build.** The frontend is hand-written vanilla JS in `index.html` (single module script). Match its patterns: `$()` helper, drawer components, `track()` for PostHog.
3. **Secrets stay server-side.** The browser may only ever see the Supabase *publishable* key and the PostHog token (via `/api/config`). The access code is checked server-side only.
4. **Dept keys are the spine.** Any new data should carry a `dept` column with the registered keys (update the check constraints in Supabase + schema.sql when adding a section); `null`/absent means global.
5. **Best-effort side effects.** Persistence, analytics, KB ingest, and memory updates must never break the primary user action — wrap them in try/catch and log.
6. **Claude usage:** ALL server-side LLM calls go through `lib/llm.js` (`generate()`), which speaks OpenAI-compatible Chat Completions to **OpenRouter** with mapped Claude slugs and optional JSON-schema output. Don't import an Anthropic SDK or call providers directly — add capabilities to `lib/llm.js`. Generation/drafts: `claude-opus-4-8`. Memory/coverage: `claude-fable-5`. Wrap each call with `captureGeneration()` (lib/posthog.js) for LLM analytics.
7. **The seed payload is replaceable — until a section has published versions.** Updating a section's base64 blob in `data/depts.json` changes its v1 (used while `dept_versions` has no rows for it). Once versions are published (e.g. IHP), the DB is canonical and content changes must flow through version generation or Agent Mode.

---

*Built by KeeMakr · Covalent discovery program · 2026*
