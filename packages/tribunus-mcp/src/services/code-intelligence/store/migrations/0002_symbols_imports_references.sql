CREATE TABLE IF NOT EXISTS code_symbols (
  symbol_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES code_files(file_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  exported BOOLEAN NOT NULL DEFAULT false,
  start_line INTEGER,
  end_line INTEGER,
  start_byte INTEGER,
  end_byte INTEGER,
  signature TEXT,
  doc_summary TEXT,
  authority_role TEXT,
  symbol_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_code_symbols_file_id ON code_symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(name);
CREATE INDEX IF NOT EXISTS idx_code_symbols_kind ON code_symbols(kind);
CREATE INDEX IF NOT EXISTS idx_code_symbols_authority_role ON code_symbols(authority_role);

CREATE TABLE IF NOT EXISTS code_imports (
  import_id TEXT PRIMARY KEY,
  from_file_id TEXT NOT NULL REFERENCES code_files(file_id) ON DELETE CASCADE,
  specifier TEXT NOT NULL,
  import_kind TEXT NOT NULL CHECK (
    import_kind IN ('value', 'type_only', 'side_effect', 'dynamic', 'require', 'unknown')
  ),
  resolution_status TEXT NOT NULL CHECK (
    resolution_status IN (
      'resolved_in_packet',
      'resolved_not_embedded',
      'resolved',
      'resolved_not_included',
      'external_package',
      'builtin',
      'ts_js_extension_remap',
      'missing_source',
      'missing_asset',
      'missing_generated',
      'missing_prompt_template',
      'missing_route_target',
      'unresolved'
    )
  ),
  resolved_file_id TEXT REFERENCES code_files(file_id),
  resolved_path TEXT,
  reason TEXT,
  start_line INTEGER,
  end_line INTEGER
);

CREATE INDEX IF NOT EXISTS idx_code_imports_from_file_id ON code_imports(from_file_id);
CREATE INDEX IF NOT EXISTS idx_code_imports_resolved_file_id ON code_imports(resolved_file_id);
CREATE INDEX IF NOT EXISTS idx_code_imports_resolution_status ON code_imports(resolution_status);

CREATE TABLE IF NOT EXISTS code_references (
  reference_id TEXT PRIMARY KEY,
  from_file_id TEXT NOT NULL REFERENCES code_files(file_id) ON DELETE CASCADE,
  from_symbol_id TEXT REFERENCES code_symbols(symbol_id) ON DELETE SET NULL,
  to_symbol_id TEXT REFERENCES code_symbols(symbol_id) ON DELETE SET NULL,
  reference_kind TEXT NOT NULL CHECK (
    reference_kind IN ('definition', 'reference', 'call', 'type_reference', 'export', 'import', 'unknown')
  ),
  start_line INTEGER,
  end_line INTEGER,
  confidence TEXT NOT NULL CHECK (
    confidence IN ('semantic', 'syntactic', 'heuristic')
  )
);

CREATE INDEX IF NOT EXISTS idx_code_references_from_symbol_id ON code_references(from_symbol_id);
CREATE INDEX IF NOT EXISTS idx_code_references_to_symbol_id ON code_references(to_symbol_id);
CREATE INDEX IF NOT EXISTS idx_code_references_kind ON code_references(reference_kind);

CREATE TABLE IF NOT EXISTS code_manifests (
  manifest_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES code_files(file_id) ON DELETE CASCADE,
  manifest_kind TEXT NOT NULL CHECK (
    manifest_kind IN ('tool', 'mcp_server', 'export_profile', 'schema', 'unknown')
  ),
  subject_id TEXT NOT NULL,
  version TEXT,
  risk_level TEXT,
  requires_active_session BOOLEAN,
  requires_hash_precondition BOOLEAN,
  requires_path_lock BOOLEAN,
  requires_approval BOOLEAN,
  side_effects_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_json JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_code_manifests_subject_id ON code_manifests(subject_id);
CREATE INDEX IF NOT EXISTS idx_code_manifests_kind ON code_manifests(manifest_kind);
