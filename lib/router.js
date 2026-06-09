// Single source of truth for all /api/* endpoints (except /api/token, which has
// its own handler). Both server.js (local) and api/[...path].js (Vercel) call route().
//
// route() takes a normalized request and returns { status, json } — no framework
// coupling, so the same logic runs in node:http and in Vercel functions.

import { NotConfigured } from "./supabase.js";
import { capture, publicConfig } from "./posthog.js";
import * as kb from "./kb.js";
import * as convo from "./conversations.js";

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

    // ---- knowledge base ----
    if (head === "kb") {
      const sub = parts[1];

      if (sub === "search" && method === "POST") {
        const results = await kb.search(body?.query, body?.limit ?? 5);
        capture("kb_search", { query: body?.query, hits: results.length });
        return ok({ results });
      }
      if (sub === "ingest" && method === "POST") {
        if (!admin()) return UNAUTH;
        if (!body?.text) return bad("text is required");
        const doc = await kb.ingest({
          title: body.title,
          text: body.text,
          source: body.source || "paste",
        });
        capture("kb_ingested", { title: doc.title, chunks: doc.chunks });
        return ok({ document: doc });
      }
      if (sub === "docs" && method === "GET") {
        if (!admin()) return UNAUTH;
        return ok({ documents: await kb.listDocs() });
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
        });
        capture("conversation_created", { agent: body?.agent }, body?.client_id);
        return ok(res);
      }
      if (!id && method === "GET") {
        if (!admin()) return UNAUTH;
        return ok({ conversations: await convo.listConversations({}) });
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
