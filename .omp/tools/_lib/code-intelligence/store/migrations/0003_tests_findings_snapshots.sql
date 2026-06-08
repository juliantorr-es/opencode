CREATE TABLE IF NOT EXISTS code_tests (
  test_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES code_files(file_id) ON DELETE CASCADE,
  suite_name TEXT,
  test_name TEXT NOT NULL,
  framework TEXT NOT NULL,
  target_file_id TEXT REFERENCES code_files(file_id),
  target_symbol_id TEXT REFERENCES code_symbols(symbol_id),
  assertion_kind TEXT,
  start_line INTEGER,
  end_line INTEGER,
  confidence TEXT NOT NULL CHECK (
    confidence IN ('semantic', 'syntactic', 'heuristic')
  )
);

CREATE INDEX IF NOT EXISTS idx_code_tests_file_id ON code_tests(file_id);
CREATE INDEX IF NOT EXISTS idx_code_tests_target_file_id ON code_tests(target_file_id);
CREATE INDEX IF NOT EXISTS idx_code_tests_assertion_kind ON code_tests(assertion_kind);

CREATE TABLE IF NOT EXISTS code_findings (
  finding_id TEXT PRIMARY KEY,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  path TEXT,
  symbol_id TEXT REFERENCES code_symbols(symbol_id),
  source_anchor_json JSONB,
  recommended_fix TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_code_findings_severity ON code_findings(severity);
CREATE INDEX IF NOT EXISTS idx_code_findings_category ON code_findings(category);

CREATE TABLE IF NOT EXISTS code_index_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  git_sha TEXT,
  git_branch TEXT,
  dirty BOOLEAN NOT NULL,
  file_count INTEGER NOT NULL,
  parsed_file_count INTEGER NOT NULL,
  symbol_count INTEGER NOT NULL,
  import_count INTEGER NOT NULL,
  reference_count INTEGER NOT NULL,
  test_count INTEGER NOT NULL,
  finding_count INTEGER NOT NULL,
  semantic_packet_path TEXT,
  source_packet_path TEXT
);

CREATE TABLE IF NOT EXISTS code_index_events (
  event_id TEXT PRIMARY KEY,
  snapshot_id TEXT REFERENCES code_index_snapshots(snapshot_id),
  event_type TEXT NOT NULL,
  path TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_code_index_events_snapshot_id ON code_index_events(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_code_index_events_type ON code_index_events(event_type);
