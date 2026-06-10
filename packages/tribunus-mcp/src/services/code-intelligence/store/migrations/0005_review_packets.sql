CREATE TABLE IF NOT EXISTS code_review_packets (
  packet_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES code_index_snapshots(snapshot_id) ON DELETE CASCADE,
  packet_kind TEXT NOT NULL CHECK (packet_kind IN ('semantic', 'source', 'paired')),
  zip_path TEXT NOT NULL,
  zip_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  warnings_json JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_code_review_packets_snapshot_id ON code_review_packets(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_code_review_packets_kind ON code_review_packets(packet_kind);
