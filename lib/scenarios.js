// Saved simulator scenarios. A "scenario" is the set of inputs that define one
// run of an interactive tool (e.g. the Finance AI-Native Org Simulator) — stored
// as jsonb in `state`, attributed to the contributor who saved it, and optionally
// forked from another person's scenario (`based_on`). The simulator's own defaults
// are the implicit "base template"; everything in the DB is someone's version.
import { requireSupabase } from "./supabase.js";

const MAX_STATE_BYTES = 200 * 1024; // a scenario is a small input bag; guard against junk

// Lightweight list for the selector (no heavy state payload), newest first.
export async function listScenarios(tool = "finance_org") {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from("sim_scenarios")
    .select("id, tool, name, created_by, based_on, created_at")
    .eq("tool", tool)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getScenario(id) {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from("sim_scenarios")
    .select("id, tool, name, created_by, based_on, state, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function createScenario({ tool = "finance_org", name, created_by, based_on, state }) {
  if (!name || !String(name).trim()) { const e = new Error("name is required"); e.code = "bad_input"; throw e; }
  if (!state || typeof state !== "object") { const e = new Error("state is required"); e.code = "bad_input"; throw e; }
  if (JSON.stringify(state).length > MAX_STATE_BYTES) { const e = new Error("state too large"); e.code = "bad_input"; throw e; }

  const sb = requireSupabase();
  const row = {
    tool,
    name: String(name).trim().slice(0, 120),
    created_by: created_by ? String(created_by).slice(0, 80) : null,
    based_on: based_on || null,
    state,
  };
  const { data, error } = await sb.from("sim_scenarios").insert(row).select("id, tool, name, created_by, based_on, state, created_at").single();
  if (error) throw error;
  return data;
}
