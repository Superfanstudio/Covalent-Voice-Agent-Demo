// Covalent Voice Agent — local dev server.
// Serves the demo page + admin panel, mints single-use Voice Agent tokens, and
// delegates every other /api/* route to the shared router (Supabase + PostHog).

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import "./lib/env.js"; // loads .env into process.env
import { route } from "./lib/router.js";

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
  res.writeHead(200, { "content-type": type });
  res.end(data);
}

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
    if (path === "/" || path === "/index.html") {
      return serveFile(res, "index.html", "text/html; charset=utf-8");
    }
    if (path === "/admin" || path === "/admin.html") {
      return serveFile(res, "admin.html", "text/html; charset=utf-8");
    }
    if (path === "/covalent-medical-logo.svg") {
      return serveFile(res, "covalent-medical-logo.svg", "image/svg+xml; charset=utf-8");
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Covalent Voice Agent → http://localhost:${PORT}`);
  console.log(`  Admin panel          → http://localhost:${PORT}/admin\n`);
});
