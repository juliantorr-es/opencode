CREATE TABLE IF NOT EXISTS code_authority_flows (
  flow_id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES code_files(file_id) ON DELETE CASCADE,
  flow_step TEXT NOT NULL,
  detected BOOLEAN NOT NULL,
  symbol_id TEXT REFERENCES code_symbols(symbol_id),
  start_line INTEGER,
  end_line INTEGER,
  confidence TEXT NOT NULL CHECK (
    confidence IN ('semantic', 'syntactic', 'heuristic', 'missing')
  ),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_code_authority_flows_tool_id ON code_authority_flows(tool_id);
CREATE INDEX IF NOT EXISTS idx_code_authority_flows_step ON code_authority_flows(flow_step);
