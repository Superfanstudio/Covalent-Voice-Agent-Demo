// Shared source documents: raw files in Supabase Storage ('shared-docs' bucket),
// extracted text in shared_documents + the dept's knowledge base. These are the
// inputs people contribute ("X shared a pricing sheet") that feed the next
// version of a function's discovery document.
import { requireSupabase } from "./supabase.js";
import * as kb from "./kb.js";

const BUCKET = "shared-docs";
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // Vercel request-body ceiling

let bucketReady = false;
async function ensureBucket(sb) {
  if (bucketReady) return;
  const { data } = await sb.storage.getBucket(BUCKET);
  if (!data) {
    const { error } = await sb.storage.createBucket(BUCKET, { public: false });
    if (error && !/already exists/i.test(error.message || "")) throw error;
  }
  bucketReady = true;
}

const safe = (s) => String(s || "file").replace(/[^\w.\-]+/g, "_").slice(0, 120);

export async function uploadDoc({ dept, title, shared_by, file_name, mime, data_b64, text_content }) {
  const sb = requireSupabase();
  await ensureBucket(sb);

  const bytes = Buffer.from(data_b64 || "", "base64");
  if (!bytes.length) { const e = new Error("Empty file"); e.code = "empty"; throw e; }
  if (bytes.length > MAX_UPLOAD_BYTES) { const e = new Error("File too large (4MB max)"); e.code = "too_large"; throw e; }

  const path = `${dept}/${Date.now()}-${safe(file_name)}`;
  const { error: upErr } = await sb.storage.from(BUCKET).upload(path, bytes, {
    contentType: mime || "application/octet-stream",
    upsert: false,
  });
  if (upErr) throw upErr;

  const { data: doc, error: insErr } = await sb
    .from("shared_documents")
    .insert({
      dept,
      title: (title || file_name || "Untitled").trim().slice(0, 200),
      shared_by: (shared_by || "").trim().slice(0, 80) || null,
      file_name: file_name || "file",
      mime: mime || null,
      size_bytes: bytes.length,
      storage_path: path,
      text_content: text_content || "",
    })
    .select("id, dept, title, shared_by, file_name, mime, size_bytes, created_at")
    .single();
  if (insErr) {
    await sb.storage.from(BUCKET).remove([path]).catch(() => {});
    throw insErr;
  }

  // Make it searchable by Kee right away (text documents only).
  if (text_content && text_content.trim().length > 40) {
    try {
      await kb.ingest({
        title: `${doc.title}${doc.shared_by ? ` (shared by ${doc.shared_by})` : ""}`,
        text: text_content,
        source: "upload",
        dept,
      });
    } catch (err) {
      console.error("[docs] KB ingest failed:", err?.message || err);
    }
  }
  return doc;
}

export async function listDocs({ dept = null } = {}) {
  const sb = requireSupabase();
  let q = sb
    .from("shared_documents")
    .select("id, dept, title, shared_by, file_name, mime, size_bytes, storage_path, version_folded, created_at")
    .order("created_at", { ascending: false })
    .limit(300);
  if (dept) q = q.eq("dept", dept);
  const { data, error } = await q;
  if (error) throw error;

  const docs = [];
  for (const d of data || []) {
    let url = null;
    try {
      const { data: signed } = await sb.storage.from(BUCKET).createSignedUrl(d.storage_path, 3600);
      url = signed?.signedUrl || null;
    } catch { /* listing still works without a link */ }
    const { storage_path, ...rest } = d;
    docs.push({ ...rest, url });
  }
  return docs;
}

// Documents contributed since a timestamp — version generation folds these in.
export async function docsSince(dept, sinceIso) {
  const sb = requireSupabase();
  let q = sb
    .from("shared_documents")
    .select("id, title, shared_by, mime, storage_path, text_content, created_at")
    .eq("dept", dept)
    .order("created_at", { ascending: true });
  if (sinceIso) q = q.gt("created_at", sinceIso);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function downloadBytes(storagePath) {
  const sb = requireSupabase();
  const { data, error } = await sb.storage.from(BUCKET).download(storagePath);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

export async function markFolded(ids, version) {
  if (!ids?.length) return;
  const sb = requireSupabase();
  await sb.from("shared_documents").update({ version_folded: version }).in("id", ids);
}
