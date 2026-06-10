// Workbook activity log: a unified, public-safe timeline of who is shaping the
// live workbook — feedback comments, completed voice calls, and version
// publishes — plus a per-contributor tally. No transcript text or secrets.
import { requireSupabase } from "./supabase.js";

export async function getActivity({ limit = 200 } = {}) {
  const sb = requireSupabase();

  const [fb, convs, vers, docs] = await Promise.all([
    sb.from("covalent_feedback")
      .select("dept, author_name, comment, created_at")
      .order("created_at", { ascending: false })
      .limit(limit),
    sb.from("conversations")
      .select("dept, agent, user_name, status, started_at, doc_version, turns(count)")
      .order("started_at", { ascending: false })
      .limit(limit),
    sb.from("dept_versions")
      .select("dept, version, created_by, change_summary, created_at")
      .order("created_at", { ascending: false })
      .limit(50),
    sb.from("shared_documents")
      .select("dept, title, shared_by, file_name, version_folded, created_at")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  if (fb.error) throw fb.error;
  if (convs.error) throw convs.error;
  if (vers.error) throw vers.error;
  if (docs.error) throw docs.error;

  const events = [];
  for (const f of fb.data || []) {
    events.push({ type: "feedback", dept: f.dept, who: f.author_name, when: f.created_at, detail: f.comment });
  }
  for (const c of convs.data || []) {
    const turns = c.turns?.[0]?.count ?? 0;
    if (!turns) continue; // skip calls that never got going
    events.push({
      type: "call",
      dept: c.dept || c.agent,
      who: c.user_name || "Anonymous",
      when: c.started_at,
      detail: `Voice call with Kee · ${turns} turn${turns === 1 ? "" : "s"}${c.doc_version ? ` · on v${c.doc_version}` : ""}`,
    });
  }
  for (const v of vers.data || []) {
    if (v.version === 1 && !v.created_by) continue; // seeded originals aren't contributions
    events.push({
      type: "version",
      dept: v.dept,
      who: v.created_by || "—",
      when: v.created_at,
      detail: `Published v${v.version}${v.change_summary ? ` — ${v.change_summary}` : ""}`,
    });
  }
  for (const d of docs.data || []) {
    events.push({
      type: "document",
      dept: d.dept,
      who: d.shared_by || "Someone",
      when: d.created_at,
      detail: `"${d.title}" (${d.file_name})${d.version_folded ? ` — folded into v${d.version_folded}` : " — feeds the next version"}`,
    });
  }
  events.sort((a, b) => new Date(b.when) - new Date(a.when));

  const tally = {};
  for (const e of events) {
    const name = (e.who || "").trim();
    if (!name || name === "—" || name.toLowerCase() === "anonymous") continue;
    const key = name.toLowerCase();
    tally[key] = tally[key] || { name, feedback: 0, calls: 0, versions: 0 };
    if (e.type === "feedback") tally[key].feedback++;
    else if (e.type === "call") tally[key].calls++;
    else if (e.type === "document") tally[key].docs = (tally[key].docs || 0) + 1;
    else tally[key].versions++;
  }
  const contributors = Object.values(tally)
    .sort((a, b) => (b.feedback + b.calls + b.versions + (b.docs || 0)) - (a.feedback + a.calls + a.versions + (a.docs || 0)));

  return { events: events.slice(0, limit), contributors };
}
