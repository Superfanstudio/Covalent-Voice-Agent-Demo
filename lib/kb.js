// Knowledge base: chunking, ingestion, full-text search, and document management.
import { requireSupabase } from "./supabase.js";

const CHUNK_SIZE = 800; // characters — small enough to return tight, on-topic context

// Split text into ~CHUNK_SIZE chunks, breaking on paragraph/sentence boundaries
// where possible so chunks stay readable.
export function chunkText(text, size = CHUNK_SIZE) {
  const clean = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const paras = clean.split(/\n{2,}/);
  const chunks = [];
  let buf = "";
  const flush = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ""; };

  for (const para of paras) {
    if (para.length > size) {
      flush();
      // hard-split very long paragraphs on sentence boundaries
      const sentences = para.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if ((buf + " " + s).trim().length > size) flush();
        buf = buf ? buf + " " + s : s;
        if (buf.length >= size) flush();
      }
      flush();
    } else if ((buf + "\n\n" + para).trim().length > size) {
      flush();
      buf = para;
    } else {
      buf = buf ? buf + "\n\n" + para : para;
    }
  }
  flush();
  return chunks;
}

export async function ingest({ title, text, source = "paste" }) {
  const sb = requireSupabase();
  const cleanTitle = (title || "Untitled").trim().slice(0, 200);
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    const err = new Error("No text to ingest");
    err.code = "empty";
    throw err;
  }

  const { data: doc, error: docErr } = await sb
    .from("kb_documents")
    .insert({ title: cleanTitle, source, char_count: String(text).length })
    .select("id, title, source, char_count, created_at")
    .single();
  if (docErr) throw docErr;

  const rows = chunks.map((content) => ({ document_id: doc.id, content }));
  const { error: chunkErr } = await sb.from("kb_chunks").insert(rows);
  if (chunkErr) {
    // roll back the document so we don't leave an empty doc behind
    await sb.from("kb_documents").delete().eq("id", doc.id);
    throw chunkErr;
  }
  return { ...doc, chunks: chunks.length };
}

export async function search(query, limit = 5) {
  const q = String(query || "").trim();
  if (!q) return [];
  const sb = requireSupabase();
  const { data, error } = await sb.rpc("search_kb", { q, k: limit });
  if (error) throw error;
  return (data || []).map((r) => ({
    title: r.title,
    content: r.content,
    rank: r.rank,
  }));
}

export async function listDocs() {
  const sb = requireSupabase();
  // doc list with chunk counts
  const { data, error } = await sb
    .from("kb_documents")
    .select("id, title, source, char_count, created_at, kb_chunks(count)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map((d) => ({
    id: d.id,
    title: d.title,
    source: d.source,
    char_count: d.char_count,
    created_at: d.created_at,
    chunks: d.kb_chunks?.[0]?.count ?? 0,
  }));
}

export async function deleteDoc(id) {
  const sb = requireSupabase();
  const { error } = await sb.from("kb_documents").delete().eq("id", id);
  if (error) throw error;
  return { deleted: id };
}
