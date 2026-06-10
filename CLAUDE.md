# Covalent Operating System — agent notes

**Read [README.md](README.md) first** — it has the architecture, project structure, data model, API table, and key flows. This file is just the rules that prevent broken builds.

## Hard rules

- **All `/api/*` logic lives in `lib/router.js`** and must work identically under `server.js` (local) and `api/router.js` (Vercel). Never add logic to `api/*.js` files.
- **Do NOT create `api/[...path].js`-style bracket catch-alls** — they silently fail on this Vercel project. Nested API paths route via the `vercel.json` rewrite to `api/router.js`.
- **No frameworks, no build step.** Frontend is vanilla JS in `index.html` (one module script). `demo.html` is frozen v1 — don't refactor it.
- **Secrets are server-side only.** Browser may see: Supabase publishable key, PostHog token. Never the service-role key, Anthropic key, or `VERSION_ACCESS_CODE` (which is also never committed — this repo is public).
- **Dept keys:** `supply | icp | ihp | sales | marcom | hr`. New per-function data gets a `dept` column.
- **Side effects are best-effort:** persistence, KB ingest, memory updates, and analytics must never break the primary action — try/catch and `console.error`.
- **Claude calls:** `@anthropic-ai/sdk`, streaming + `finalMessage()`, `thinking: {type:"adaptive"}`, structured outputs via `output_config.format`. No `temperature`/`top_p` (400s). Models: `claude-opus-4-8` (generation/drafts), `claude-fable-5` (memory).

## Verify

- Lib changes: `node -e "import('./lib/router.js')"` then restart the dev server (ESM cache).
- Local run: `ASSEMBLYAI_API_KEY=dummy PORT=3456 node server.js`; without Supabase keys every feature must degrade gracefully (503 + `code`), never crash.
- DB schema changes: apply to Supabase project `wxividqrrmsbuaxncpsn` AND mirror in `supabase/schema.sql` (keep idempotent).
- `GET /api/health` reports env/schema readiness.
