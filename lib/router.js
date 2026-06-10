// Single source of truth for all /api/* endpoints (except /api/token, which has
// its own handler). Both server.js (local) and api/[...path].js (Vercel) call route().
//
// route() takes a normalized request and returns { status, json } — no framework
// coupling, so the same logic runs in node:http and in Vercel functions.

import { NotConfigured } from "./supabase.js";
import { capture, publicConfig } from "./posthog.js";
import * as kb from "./kb.js";
import * as convo from "./conversations.js";
import * as versions from "./versions.js";

const ok = (json) => ({ status: 200, json });
const bad = (msg) => ({ status: 400, json: { error: msg } });
const UNAUTH = { status: 401, json: { error: "Admin authentication required", code: "admin_auth" } };

// Admin gate: when ADMIN_PASSWORD is set, admin-only routes require a matching
// x-admin-password header. When unset, everything is open (e.g. localhost).
function isAdmin(headers) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return true;
  return headers && headers["x-admin-password"] === pw;
}

export async function route({ method, pathname, query, body, headers = {} }) {
  // pathname like "/api/kb/search" -> ["kb","search"]
  const parts = pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const head = parts[0];
  const admin = () => isAdmin(headers); // call where an admin-only action is gated

  try {
    // ---- public browser config (no secrets) ----
    if (head === "config" && method === "GET") {
      return ok(publicConfig());
    }

    // ---- versioned function documents ----
    if (head === "versions") {
      const sub = parts[1];

      // GET /api/versions?dept=icp → version list for the dropdown
      if (!sub && method === "GET") {
        const dept = query?.dept;
        if (!dept) return bad("dept is required");
        return ok({ dept, versions: await versions.listVersions(dept) });
      }
      // GET /api/versions/current?dept=icp[&v=2] → full html of a version
      if (sub === "current" && method === "GET") {
        const dept = query?.dept;
        if (!dept) return bad("dept is required");
        const v = await versions.getVersion(dept, query?.v ? Number(query.v) : undefined);
        if (!v) return { status: 404, json: { error: "No document for this function" } };
        return ok(v);
      }
      // POST /api/versions/generate {dept, access_code, created_by} → new version
      if (sub === "generate" && method === "POST") {
        try {
          const res = await versions.generateVersion({
            dept: body?.dept,
            accessCode: body?.access_code,
            createdBy: body?.created_by,
          });
          capture("version_generated", { dept: res.dept, version: res.version, applied: res.applied }, body?.created_by);
          return ok(res);
        } catch (err) {
          if (err?.code === "bad_access_code") return { status: 403, json: { error: err.message, code: err.code } };
          if (err?.code === "no_inputs" || err?.code === "bad_dept" || err?.code === "bad_model_output") {
            return { status: 400, json: { error: err.message, code: err.code } };
          }
          if (err?.code === "not_configured") return { status: 503, json: { error: err.message, code: err.code } };
          throw err;
        }
      }
    }

    // ---- knowledge base ----
    if (head === "kb") {
      const sub = parts[1];

      if (sub === "search" && method === "POST") {
        const results = await kb.search(body?.query, body?.limit ?? 5, body?.dept);
        capture("kb_search", { query: body?.query, dept: body?.dept, hits: results.length });
        return ok({ results });
      }
      if (sub === "ingest" && method === "POST") {
        if (!admin()) return UNAUTH;
        if (!body?.text) return bad("text is required");
        const doc = await kb.ingest({
          title: body.title,
          text: body.text,
          source: body.source || "paste",
          dept: body.dept || null,
        });
        capture("kb_ingested", { title: doc.title, dept: doc.dept, chunks: doc.chunks });
        return ok({ document: doc });
      }
      if (sub === "docs" && method === "GET") {
        if (!admin()) return UNAUTH;
        return ok({ documents: await kb.listDocs({ dept: query?.dept || null }) });
      }
      // POST /api/kb/seed — (re)build each function's KB doc from its current
      // document version (artifact fallback included). Admin-gated; idempotent.
      if (sub === "seed" && method === "POST") {
        if (!admin()) return UNAUTH;
        const seeded = [];
        for (const dept of versions.DEPTS) {
          const v = await versions.getVersion(dept);
          if (!v) continue;
          await versions.reseedKb(dept, v.version, v.html);
          seeded.push({ dept, version: v.version });
        }
        capture("kb_seeded", { depts: seeded.length });
        return ok({ seeded });
      }
      if (sub === "docs" && method === "DELETE") {
        if (!admin()) return UNAUTH;
        const id = query?.id;
        if (!id) return bad("id is required");
        const res = await kb.deleteDoc(id);
        capture("kb_deleted", { id });
        return ok(res);
      }
    }

    // ---- conversations & transcripts ----
    if (head === "conversations") {
      const id = parts[1];

      if (!id && method === "POST") {
        const res = await convo.createConversation({
          agent: body?.agent,
          voice: body?.voice,
          client_id: body?.client_id,
          dept: body?.dept,
          user_name: body?.user_name,
          doc_version: body?.doc_version,
        });
        capture("conversation_created", { agent: body?.agent, dept: body?.dept, user_name: body?.user_name }, body?.client_id);
        return ok(res);
      }
      if (!id && method === "GET") {
        if (!admin()) return UNAUTH;
        return ok({ conversations: await convo.listConversations({ dept: query?.dept || null }) });
      }
      if (id && method === "GET") {
        if (!admin()) return UNAUTH;
        return ok({ conversation: await convo.getConversation(id) });
      }
      if (id && (method === "PATCH" || method === "POST")) {
        await convo.endConversation(id, body?.status || "ended");
        return ok({ ok: true });
      }
    }

    // ---- transcript turns ----
    if (head === "turns" && method === "POST") {
      if (!body?.conversation_id || !body?.role || !body?.text) {
        return bad("conversation_id, role and text are required");
      }
      await convo.addTurn({
        conversation_id: body.conversation_id,
        role: body.role,
        text: body.text,
      });
      return ok({ ok: true });
    }

    return { status: 404, json: { error: "Not found" } };
  } catch (err) {
    if (err instanceof NotConfigured) {
      return { status: 503, json: { error: err.message, code: err.code } };
    }
    // Tables not created yet → guide the operator to run the schema.
    const msg = String(err?.message || err);
    if (err?.code === "PGRST205" || err?.code === "42P01" || /Could not find the table|does not exist/i.test(msg)) {
      return { status: 503, json: { error: "Database tables not found — run supabase/schema.sql in the Supabase SQL editor.", code: "schema_missing" } };
    }
    console.error(`[api] ${method} ${pathname}:`, msg);
    return { status: 500, json: { error: msg } };
  }
}
