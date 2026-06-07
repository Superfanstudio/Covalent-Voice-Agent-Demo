// ICP Discovery Agent — tiny zero-dependency server.
// Serves the demo page and mints single-use Voice Agent tokens server-side
// so the AssemblyAI API key never reaches the browser.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// --- Load ASSEMBLYAI_API_KEY from .env (no dotenv dependency) ---------------
async function loadApiKey() {
  if (process.env.ASSEMBLYAI_API_KEY) return process.env.ASSEMBLYAI_API_KEY;
  try {
    const raw = await readFile(join(__dirname, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*ASSEMBLYAI_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return null;
}

const API_KEY = await loadApiKey();
if (!API_KEY) {
  console.error("\n  ✗ ASSEMBLYAI_API_KEY not found in environment or .env\n");
  process.exit(1);
}

// --- Token endpoint ---------------------------------------------------------
// Mints a fresh, single-use token for each browser session / reconnect.
async function mintToken() {
  const url =
    "https://agents.assemblyai.com/v1/token" +
    "?expires_in_seconds=300&max_session_duration_seconds=600";
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`token endpoint ${res.status}: ${await res.text()}`);
  }
  return res.json(); // { token: "..." }
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/api/token" || req.url === "/token") {
      const data = await mintToken();
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(data));
      return;
    }

    if (req.url === "/" || req.url === "/index.html") {
      const html = await readFile(join(__dirname, "index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
});

server.listen(PORT, () => {
  console.log(`\n  ICP Discovery Agent running → http://localhost:${PORT}\n`);
});
