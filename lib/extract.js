// Plain-text extraction from section HTML, for KB ingestion and agent context.
//
// Section pages come in three shapes:
//   1. Plain HTML (icp, ihp)            → strip tags.
//   2. JS-rendered (marcom, hr, supply) → content lives in string literals inside
//      inline <script> data objects     → harvest readable string literals.
//   3. Nested shells (sales)            → sub-pages stored as base64 JSON blobs
//      in <script type="application/json"> → decode and recurse.

const B64_RE = /^[A-Za-z0-9+/=\s]{200,}$/;

function decodeB64(b64) {
  return Buffer.from(b64, "base64").toString("utf8");
}

// Readable string literals out of inline JS (data objects hold the page copy).
function literalsFromScript(js) {
  const out = [];
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
  let m;
  while ((m = re.exec(js))) {
    let s = (m[1] ?? m[2] ?? "").replace(/\\(["'\\/])/g, "$1").replace(/\\n/g, "\n");
    const trimmed = s.trim();
    if (trimmed.length < 12) continue;                       // ids, colors, keys
    if (!/[a-zA-Z]{3}/.test(trimmed)) continue;              // no real words
    if (/^[#.][\w-]+$/.test(trimmed)) continue;              // css selectors
    if (/^https?:\/\/\S+$/.test(trimmed)) continue;          // bare urls
    if ((trimmed.match(/\s/g) || []).length < 1) continue;   // single tokens
    out.push(trimmed);
  }
  return out;
}

export function htmlToText(html, depth = 0) {
  if (depth > 3 || !html) return "";
  const parts = [];

  // 1) JSON blobs of base64 sub-pages → recurse into each decoded page
  const jsonBlobs = [...html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)];
  for (const [, blob] of jsonBlobs) {
    try {
      const data = JSON.parse(blob);
      for (const v of Object.values(data)) {
        if (typeof v === "string" && B64_RE.test(v.slice(0, 400))) {
          parts.push(htmlToText(decodeB64(v), depth + 1));
        }
      }
    } catch { /* not parseable — ignore */ }
  }

  // 2) Inline JS data objects → harvest string literals
  const scripts = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)];
  for (const [, js] of scripts) {
    if (js.length > 2000) parts.push(literalsFromScript(js).join("\n"));
  }

  // 3) The HTML itself → strip style/script/tags, decode entities
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<(h[1-6]|p|div|li|tr|section|article|br)[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&middot;/g, "·")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
  parts.push(stripped);

  // De-duplicate lines (JS literals often repeat in markup) while keeping order
  const seen = new Set();
  const lines = [];
  for (const line of parts.join("\n\n").split("\n")) {
    const key = line.trim();
    if (!key) { lines.push(""); continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
