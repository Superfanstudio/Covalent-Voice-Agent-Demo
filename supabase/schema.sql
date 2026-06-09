-- Covalent Voice Agent — Supabase schema
-- Run this once in the Supabase SQL editor (or `supabase db` tooling).
-- No pgvector: the knowledge base uses Postgres full-text search.

-- ---------- Conversations & transcripts ----------------------------------
create table if not exists conversations (
  id          uuid primary key default gen_random_uuid(),
  agent       text not null,                      -- 'icp' | 'hiring'
  voice       text,
  status      text not null default 'live',       -- 'live' | 'ended' | 'error'
  client_id   text,                               -- anonymous browser id (PostHog distinct_id)
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);

create table if not exists turns (
  id               bigint generated always as identity primary key,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  role             text not null,                 -- 'agent' | 'user'
  text             text not null,
  created_at       timestamptz not null default now()
);

create index if not exists turns_conversation_idx
  on turns (conversation_id, created_at);

-- ---------- Knowledge base ------------------------------------------------
create table if not exists kb_documents (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  source      text,                               -- e.g. 'paste', a filename, or a URL
  char_count  int not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists kb_chunks (
  id           bigint generated always as identity primary key,
  document_id  uuid not null references kb_documents(id) on delete cascade,
  content      text not null,
  -- Full-text search vector, generated from the chunk content.
  tsv          tsvector generated always as (to_tsvector('english', content)) stored
);

create index if not exists kb_chunks_tsv_idx on kb_chunks using gin (tsv);
create index if not exists kb_chunks_document_idx on kb_chunks (document_id);

-- ---------- search_kb(query, limit) — ranked full-text search -------------
-- Returns the best-matching chunks with their parent document title.
create or replace function search_kb(q text, k int default 5)
returns table (chunk_id bigint, document_id uuid, title text, content text, rank real)
language sql stable as $$
  select c.id, c.document_id, d.title, c.content,
         ts_rank(c.tsv, websearch_to_tsquery('english', q)) as rank
  from kb_chunks c
  join kb_documents d on d.id = c.document_id
  where c.tsv @@ websearch_to_tsquery('english', q)
  order by rank desc
  limit greatest(k, 1);
$$;
