// Conversation + transcript persistence.
import { requireSupabase } from "./supabase.js";

export async function createConversation({ agent, voice, client_id, dept, user_name, doc_version }) {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from("conversations")
    .insert({
      agent,
      voice,
      client_id,
      dept: dept || agent || null,
      user_name: user_name || null,
      doc_version: doc_version || null,
      status: "live",
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id };
}

export async function endConversation(id, status = "ended") {
  const sb = requireSupabase();
  const { error } = await sb
    .from("conversations")
    .update({ status, ended_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
  return { ok: true };
}

// Find conversations stranded in "live" (the call-end request never arrived —
// e.g. the tab was closed mid-call) and end them. Returns the ones that were
// closed so the caller can fold each into memory, exactly as a normal call-end
// would. maxAgeMin defaults well beyond the 10-minute max session duration.
export async function reapStale({ maxAgeMin = 30 } = {}) {
  const sb = requireSupabase();
  const cutoff = new Date(Date.now() - maxAgeMin * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from("conversations")
    .select("id, dept")
    .eq("status", "live")
    .lt("started_at", cutoff);
  if (error) throw error;
  const stale = data || [];
  for (const c of stale) {
    try { await endConversation(c.id, "ended"); }
    catch (err) { console.error("[convo] reap end failed:", c.id, err?.message || err); }
  }
  return stale;
}

export async function addTurn({ conversation_id, role, text }) {
  const sb = requireSupabase();
  const { error } = await sb
    .from("turns")
    .insert({ conversation_id, role, text });
  if (error) throw error;
  return { ok: true };
}

export async function listConversations({ limit = 100, dept = null } = {}) {
  const sb = requireSupabase();
  let q = sb
    .from("conversations")
    .select("id, agent, dept, doc_version, user_name, voice, status, started_at, ended_at, turns(count)")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (dept) q = q.eq("dept", dept);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map((c) => ({
    id: c.id,
    agent: c.agent,
    dept: c.dept,
    doc_version: c.doc_version,
    user_name: c.user_name,
    voice: c.voice,
    status: c.status,
    started_at: c.started_at,
    ended_at: c.ended_at,
    turns: c.turns?.[0]?.count ?? 0,
  }));
}

// Delete a conversation (its turns cascade-delete via FK).
export async function deleteConversation(id) {
  const sb = requireSupabase();
  const { error } = await sb.from("conversations").delete().eq("id", id);
  if (error) throw error;
  return { deleted: id };
}

export async function getConversation(id) {
  const sb = requireSupabase();
  const { data: conv, error: convErr } = await sb
    .from("conversations")
    .select("id, agent, dept, doc_version, user_name, voice, status, started_at, ended_at, client_id")
    .eq("id", id)
    .maybeSingle();
  if (convErr) throw convErr;
  if (!conv) return null;

  const { data: turns, error: turnsErr } = await sb
    .from("turns")
    .select("role, text, created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });
  if (turnsErr) throw turnsErr;

  return { ...conv, turns: turns || [] };
}
