-- OrderFlow Phase 2 schema
-- Run with: docker exec -i orderflow-pg psql -U postgres -d orderflow < db/schema.sql

-- 1. Enable the pgvector extension. Safe to re-run (no-op if already enabled).
create extension if not exists vector;

-- 2. The chunks table.
-- One row per embeddable piece of text. Many chunks can belong to one article
-- (grouped via article_slug). For Phase 2 most articles will be a single chunk;
-- longer articles can be split later without a migration.
create table if not exists chunks (
  id            bigserial   primary key,
  article_slug  text        not null,        -- filename without .md, e.g. "refunding-an-order"
  article_title text        not null,        -- pulled from the article's YAML frontmatter
  chunk_index   int         not null,        -- 0 for the first chunk of an article
  content       text        not null,        -- the actual text passed to the embedding model
  embedding     vector(768) not null,        -- output of Ollama's nomic-embed-text
  created_at    timestamptz not null default now(),
  unique (article_slug, chunk_index)         -- lets the embed script upsert idempotently
);

-- 3. No ANN index for now.
--
-- We deliberately don't create an ivfflat/hnsw index at this scale (~20 rows).
-- ANN indexes are approximate — they trade recall for speed by partitioning
-- the vector space into clusters and only searching the nearest ones. That
-- speed-up only pays off when there are thousands of rows; at 20 rows a
-- sequential scan is both faster AND perfectly accurate.
--
-- Worse, ivfflat must be built AFTER the data is loaded (clusters are derived
-- from existing vectors). Building it on an empty table — like we did
-- originally — gives arbitrary cluster centroids and terrible recall.
--
-- When the knowledge base grows past ~10k chunks, add an index then:
--   CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);

-- Index on article_slug for fast "show me all chunks of article X" lookups.
create index if not exists chunks_article_slug_idx on chunks (article_slug);
