CREATE TABLE IF NOT EXISTS code_files (
  file_id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  language TEXT,
  category TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  line_count INTEGER,
  importance TEXT NOT NULL CHECK (
    importance IN ('authority_critical', 'review_context', 'background', 'low_signal')
  ),
  inclusion_status TEXT NOT NULL CHECK (
    inclusion_status IN ('included', 'indexed_only', 'excluded')
  ),
  parse_status TEXT NOT NULL CHECK (
    parse_status IN ('pending', 'parsed', 'parse_error', 'unsupported_language', 'not_source')
  ),
  parse_error TEXT,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_code_files_path ON code_files(path);
CREATE INDEX IF NOT EXISTS idx_code_files_sha256 ON code_files(sha256);
CREATE INDEX IF NOT EXISTS idx_code_files_category ON code_files(category);
CREATE INDEX IF NOT EXISTS idx_code_files_importance ON code_files(importance);
