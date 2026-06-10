// Vercel handler for every /api/* route except /api/token (token.js wins by
// filesystem precedence). Reached via the vercel.json rewrite
//   /api/:path*  →  /api/router?p=:path*
// because bracket catch-all files ([...path].js) don't match nested segments
// on this project. Delegates to the shared router.
import { route } from "../lib/router.js";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  // Path arrives via the rewrite's ?p= param; fall back to the URL path for
  // direct hits (e.g. /api/router?p=... or a platform that preserves the path).
  const p = url.searchParams.get("p");
  url.searchParams.delete("p");
  const pathname = p ? `/api/${p}` : url.pathname;

  const query = Object.fromEntries(url.searchParams.entries());
  const body = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method)
    ? await readBody(req)
    : {};

  const { status, json } = await route({
    method: req.method,
    pathname,
    query,
    body,
    headers: req.headers,
  });

  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.status(status).json(json);
}
