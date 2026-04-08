-- Enable pgvector extension
create extension if not exists vector with schema extensions;

-- Store chunked doc embeddings for RAG search
create table doc_embeddings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  page_id uuid not null references doc_pages(id) on delete cascade,
  chunk_index integer not null,
  chunk_text text not null,
  embedding vector(768) not null,
  page_title text not null,
  page_slug text not null,
  created_at timestamptz default now()
);

create index idx_doc_embeddings_project_id on doc_embeddings(project_id);
create index idx_doc_embeddings_page_id on doc_embeddings(page_id);

-- HNSW index for fast cosine similarity search
create index idx_doc_embeddings_vector on doc_embeddings
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- RLS: users can only access embeddings for their own projects
alter table doc_embeddings enable row level security;

create policy "Users access own project embeddings"
  on doc_embeddings for all
  using (project_id in (select id from projects where user_id = auth.uid()));

-- Search function: returns top-k most similar chunks for a project
create or replace function match_doc_chunks(
  p_project_id uuid,
  p_embedding vector(768),
  p_match_count integer default 8,
  p_match_threshold float default 0.3
)
returns table (
  id uuid,
  page_id uuid,
  page_title text,
  page_slug text,
  chunk_index integer,
  chunk_text text,
  similarity float
)
language sql stable
as $$
  select
    doc_embeddings.id,
    doc_embeddings.page_id,
    doc_embeddings.page_title,
    doc_embeddings.page_slug,
    doc_embeddings.chunk_index,
    doc_embeddings.chunk_text,
    1 - (doc_embeddings.embedding <=> p_embedding) as similarity
  from doc_embeddings
  where doc_embeddings.project_id = p_project_id
    and 1 - (doc_embeddings.embedding <=> p_embedding) > p_match_threshold
  order by doc_embeddings.embedding <=> p_embedding
  limit p_match_count;
$$;
