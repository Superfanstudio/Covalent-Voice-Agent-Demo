// Loads .env into process.env for local dev (no dotenv dependency).
// On Vercel, env vars are already present in process.env, so this is a no-op
// for any key that's already set. Safe to import many times (runs once).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let loaded = false;

export function loadEnv() {
  if (loaded) return;
  loaded = true;
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const raw = readFileSync(join(root, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      val = val.replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // No .env file (e.g. on Vercel) — rely on the platform's env.
  }
}

loadEnv();
