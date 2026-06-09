// Server-side Supabase client (service role). Never import this in the browser.
import "./env.js";
import { createClient } from "@supabase/supabase-js";

let client = null;

export function getSupabase() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null; // not configured — callers degrade gracefully
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

// Thrown when an endpoint needs Supabase but it isn't configured.
export class NotConfigured extends Error {
  constructor() {
    super("Supabase is not configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)");
    this.code = "supabase_not_configured";
  }
}

export function requireSupabase() {
  const sb = getSupabase();
  if (!sb) throw new NotConfigured();
  return sb;
}
