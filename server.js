// Covalent Discovery — local dev server.
// Serves the Operating System shell (index.html), the original voice demo
// (demo.html), and the admin panel; mints single-use Voice Agent tokens; and
// delegates every other /api/* route to the shared router (Supabase + PostHog).

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import "./lib/env.js"; // loads .env into process.env
import { route } from "./lib/router.js";
import { shutdown as phShutdown } from "./lib/posthog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.ASSEMBLYAI_API_KEY;
if (!API_KEY) {
  console.error("\n  ✗ ASSEMBLYAI_API_KEY not found in environment or .env\n");
  process.exit(1);
}

// --- Token endpoint ---------------------------------------------------------
async function mintToken() {
  const url =
    "https://agents.assemblyai.com/v1/token" +
    "?expires_in_seconds=300&max_session_duration_seconds=600";
  const res = await fetch(url, { headers: { authorization: `Bearer ${API_KEY}` } });
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${await res.text()}`);
  return res.json(); // { token: "..." }
}

function sendJson(res, status, json) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(json));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function serveFile(res, name, type) {
  const data = await readFile(join(__dirname, name), "utf8");
  // no-store so the browser always runs the latest HTML/JS in dev — otherwise a
  // cached index.html silently keeps serving old code after edits.
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(data);
}

// Static routes: path → [file, content-type]
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/personas.js": ["personas.js", "text/javascript; charset=utf-8"],
  "/finance-sim.html": ["finance-sim.html", "text/html; charset=utf-8"],
  "/data/depts.json": ["data/depts.json", "application/json; charset=utf-8"],
  "/covalent-medical-logo.svg": ["covalent-medical-logo.svg", "image/svg+xml; charset=utf-8"],
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;

    // Token (kept separate from the router, mirrors api/token.js on Vercel)
    if (path === "/api/token" || path === "/token") {
      return sendJson(res, 200, await mintToken());
    }

    // All other /api/* routes → shared router
    if (path.startsWith("/api/")) {
      const body = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method)
        ? await readBody(req)
        : {};
      const query = Object.fromEntries(url.searchParams.entries());
      const { status, json } = await route({ method: req.method, pathname: path, query, body, headers: req.headers });
      return sendJson(res, status, json);
    }

    // Pages & assets
    if (STATIC[path]) {
      return serveFile(res, STATIC[path][0], STATIC[path][1]);
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Covalent Operating System → http://localhost:${PORT}\n`);
});

// Flush PostHog before the process exits so no events are lost on redeploy.
async function gracefulShutdown() {
  await phShutdown().catch(() => {});
  process.exit(0);
}
process.once("SIGTERM", gracefulShutdown);
process.once("SIGINT", gracefulShutdown);
