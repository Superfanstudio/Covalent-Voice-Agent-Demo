-- Covalent Discovery OS — Supabase schema (project: covalent-feedback / wxividqrrmsbuaxncpsn)
-- Idempotent: safe to run more than once in the Supabase SQL editor.
-- All app tables are accessed server-side with the service role (RLS enabled, no
-- public policies). covalent_feedback is the one exception: the browser writes to
-- it directly with the publishable key (policies created with the original artifact).
-- Raw uploaded files live in the private 'shared-docs' Storage bucket (created
-- automatically by the server on first upload).

-- ---------- Conversations & transcripts ------------------------------------
create table if not exists conversations (
  id          uuid primary key default gen_random_uuid(),
  agent       text not null,                      -- persona key, same as dept: 'icp','ihp','sales','marcom','hr','supply'
  dept        text,                               -- function/section this call covered
  doc_version int,                                -- dept_versions.version the caller was viewing
  voice       text,
  status      text not null default 'live',       -- 'live' | 'ended' | 'error'
  client_id   text,                               -- anonymous browser id (PostHog distinct_id)
  user_name   text,                               -- captured display name
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);
alter table conversations enable row level security;

create table if not exists turns (
  id               bigint generated always as identity primary key,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  role             text not null,                 -- 'agent' | 'user'
  text             text not null,
  created_at       timestamptz not null default now()
);
create index if not exists turns_conversation_idx on turns (conversation_id, created_at);
alter table turns enable row level security;

-- ---------- Knowledge base (dept-scoped, full-text search) ------------------
create table if not exists kb_documents (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  source      text,                               -- 'paste' | 'seed' | 'version' | 'upload' | filename/url
  dept        text,                               -- null = global (searchable from every section)
  char_count  int not null default 0,
  created_at  timestamptz not null default now()
);
alter table kb_documents enable row level security;

create table if not exists kb_chunks (
  id           bigint generated always as identity primary key,
  document_id  uuid not null references kb_documents(id) on delete cascade,
  content      text not null,
  tsv          tsvector generated always as (to_tsvector('english', content)) stored
);
create index if not exists kb_chunks_tsv_idx on kb_chunks using gin (tsv);
create index if not exists kb_chunks_document_idx on kb_chunks (document_id);
alter table kb_chunks enable row level security;

-- Ranked full-text search, optionally scoped to a dept (global docs always included)
create or replace function search_kb(q text, k int default 5, dept_filter text default null)
returns table (chunk_id bigint, document_id uuid, title text, content text, rank real)
language sql stable as $$
  select c.id, c.document_id, d.title, c.content,
         ts_rank(c.tsv, websearch_to_tsquery('english', q)) as rank
  from kb_chunks c
  join kb_documents d on d.id = c.document_id
  where c.tsv @@ websearch_to_tsquery('english', q)
    and (dept_filter is null or d.dept is null or d.dept = dept_filter)
  order by rank desc
  limit greatest(k, 1);
$$;

-- ---------- Versioned function documents ------------------------------------
-- Each row is a full snapshot of one function's page. v1 is seeded from the
-- original artifact; later versions are generated from feedback + transcripts
-- + shared documents.
create table if not exists dept_versions (
  id              uuid primary key default gen_random_uuid(),
  dept            text not null check (dept in ('overview','supply','icp','ihp','sales','marcom','hr')),
  version         int  not null,
  html            text not null,                  -- full section HTML for this version
  change_summary  text,                           -- human-readable "what changed"
  change_log      jsonb,                          -- [{excerpt, reason, source}] applied edits
  sources         jsonb,                          -- {feedback_ids:[], conversation_ids:[], document_ids:[]}
  created_by      text,                           -- name of the person who triggered generation
  created_at      timestamptz not null default now(),
  unique (dept, version)
);
create index if not exists dept_versions_dept_idx on dept_versions (dept, version desc);
alter table dept_versions enable row level security;

-- ---------- Shared source documents -----------------------------------------
create table if not exists shared_documents (
  id             uuid primary key default gen_random_uuid(),
  dept           text not null check (dept in ('overview','supply','icp','ihp','sales','marcom','hr')),
  title          text not null,
  shared_by      text,                              -- who shared the information
  file_name      text not null,
  mime           text,
  size_bytes     int,
  storage_path   text not null,                     -- path in the 'shared-docs' bucket
  text_content   text,                              -- extracted text ('' for images)
  version_folded int,                               -- dept_versions.version that incorporated it (null = pending)
  created_at     timestamptz not null default now()
);
create index if not exists shared_documents_dept_idx on shared_documents (dept, created_at desc);
alter table shared_documents enable row level security;

-- ---------- Agent Mode drafts ------------------------------------------------
-- Operator-directed edits staged for review before publishing as a version.
create table if not exists dept_drafts (
  id             uuid primary key default gen_random_uuid(),
  dept           text not null check (dept in ('overview','supply','icp','ihp','sales','marcom','hr')),
  base_version   int not null,                     -- published version the draft builds on
  html           text not null,                    -- draft document (with change marks)
  change_summary text,
  change_log     jsonb,                            -- cumulative applied edits
  instructions   jsonb,                            -- [{by, text, at}] operator asks, in order
  created_by     text,
  status         text not null default 'draft',    -- 'draft' | 'published' | 'discarded'
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists dept_drafts_dept_idx on dept_drafts (dept, status, updated_at desc);
alter table dept_drafts enable row level security;

-- ---------- Kee's persistent memory (the workbook "AI brain") ---------------
-- One living document maintained by Claude Fable from all transcripts,
-- feedback, documents, and versions; injected into every voice call.
create table if not exists agent_memory (
  id         text primary key default 'global',
  content    text not null default '',
  stats      jsonb,
  updated_at timestamptz not null default now()
);
alter table agent_memory enable row level security;
