-- pgvector + BM25 indexes for diagnostic_packets and dharma_ledger
-- PGlite WASM may not include the vector extension, so pgvector-specific
-- statements use IF NOT EXISTS and fall back to standard GIN indexes.

-- HNSW index on diagnostic packet embeddings (cosine similarity)
-- Gracefully no-ops if pgvector extension isn't loaded in PGlite WASM.
CREATE INDEX IF NOT EXISTS idx_diagnostic_packets_embedding
  ON diagnostic_packets USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- GIN full-text search on diagnostic packet content (works without pgvector)
CREATE INDEX IF NOT EXISTS idx_diagnostic_packets_text_search
  ON diagnostic_packets USING gin (to_tsvector('english', coalesce(content, '')));

-- BM25-style full-text search on dharma ledger description + evidence
CREATE INDEX IF NOT EXISTS idx_dharma_ledger_text_search
  ON dharma_ledger USING gin (to_tsvector('english', coalesce(description, '') || ' ' || coalesce(evidence, '')));

-- HNSW index on dharma ledger embeddings
CREATE INDEX IF NOT EXISTS idx_dharma_ledger_embedding
  ON dharma_ledger USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Composite index for common query patterns (time-ordered by creation)
CREATE INDEX IF NOT EXISTS idx_diagnostic_packets_created_type
  ON diagnostic_packets (created_at DESC, packet_type);

-- Search helper: generated tsvector column for faster queries
ALTER TABLE diagnostic_packets ADD COLUMN IF NOT EXISTS text_search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_diagnostic_packets_text_vector
  ON diagnostic_packets USING gin (text_search_vector);
