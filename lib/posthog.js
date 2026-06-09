// Server-side PostHog capture (posthog-node). Best-effort: never throws into callers.
import "./env.js";
import { PostHog } from "posthog-node";

let client = null;

function getClient() {
  if (client !== null) return client;
  const key = process.env.POSTHOG_PROJECT_TOKEN;
  if (!key) {
    client = false; // not configured
    return client;
  }
  client = new PostHog(key, {
    host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
    flushAt: 1,        // small server — flush eagerly
    flushInterval: 0,
  });
  return client;
}

export function capture(event, properties = {}, distinctId = "server") {
  try {
    const c = getClient();
    if (!c) return;
    c.capture({ distinctId, event, properties });
  } catch {
    // monitoring must never break a request
  }
}

// Public config the browser is allowed to know (no secrets).
export function publicConfig() {
  return {
    posthogToken: process.env.POSTHOG_PROJECT_TOKEN || null,
    posthogHost: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
  };
}
