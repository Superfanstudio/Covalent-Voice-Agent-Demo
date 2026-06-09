// Vercel catch-all for every /api/* route except /api/token (token.js wins by
// being a more specific file). Delegates to the shared router.
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
  const query = Object.fromEntries(url.searchParams.entries());
  const body = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method)
    ? await readBody(req)
    : {};

  const { status, json } = await route({
    method: req.method,
    pathname: url.pathname,
    query,
    body,
    headers: req.headers,
  });

  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.status(status).json(json);
}
