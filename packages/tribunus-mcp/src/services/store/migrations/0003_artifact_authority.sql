-- Artifact Authority v1 — durable artifact registry, lifecycle events, verification, lineage

CREATE TABLE IF NOT EXISTS artifacts_v2 (
  artifact_id         TEXT PRIMARY KEY,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  artifact_type       TEXT NOT NULL,
  logical_name        TEXT,
  state               TEXT NOT NULL DEFAULT 'reserved'
                        CHECK (state IN ('reserved','producing','finalized','verified','verification_failed','superseded','partial','quarantined','deletion_pending','deleted','missing')),
  content_algorithm   TEXT NOT NULL DEFAULT 'sha256',
  content_digest      TEXT,
  manifest_digest     TEXT,
  canonical_path      TEXT NOT NULL,
  byte_count          INTEGER,
  file_count          INTEGER,
  mime_type           TEXT,
  producer_tool       TEXT,
  producer_tool_version TEXT,
  invocation_id       TEXT,
  parent_invocation_id TEXT,
  session_id          TEXT,
  source_commit       TEXT,
  source_dirty        BOOLEAN,
  normalized_argument_digest TEXT,
  capability_policy_digest   TEXT,
  machine_profile_digest     TEXT,
  created_at          TEXT NOT NULL DEFAULT (to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  finalized_at        TEXT,
  verified_at         TEXT,
  superseded_at       TEXT,
  deleted_at          TEXT,
  verification_status TEXT NOT NULL DEFAULT 'none'
                        CHECK (verification_status IN ('none','passed','failed','stale')),
  verification_receipt_id TEXT,
  superseded_by_id    TEXT REFERENCES artifacts_v2(artifact_id),
  retention_policy    TEXT NOT NULL DEFAULT 'mission_evidence'
                        CHECK (retention_policy IN ('permanent','mission_evidence','cache','temporary','imported_external')),
  destination_mode    TEXT NOT NULL DEFAULT 'exact_path'
                        CHECK (destination_mode IN ('exact_path','directory','content_addressed')),
  provenance          TEXT NOT NULL DEFAULT 'tribunus_produced'
                        CHECK (provenance IN ('tribunus_produced','imported')),
  metadata            TEXT,
  -- Constraints
  CONSTRAINT ck_finalized_has_digest CHECK (state IN ('reserved','producing','partial','deletion_pending') OR content_digest IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS artifact_manifests (
  artifact_id    TEXT PRIMARY KEY REFERENCES artifacts_v2(artifact_id),
  manifest_json  TEXT NOT NULL,
  entry_count    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE IF NOT EXISTS artifact_relationships (
  source_artifact_id      TEXT NOT NULL REFERENCES artifacts_v2(artifact_id),
  destination_artifact_id TEXT NOT NULL REFERENCES artifacts_v2(artifact_id),
  relationship            TEXT NOT NULL
                            CHECK (relationship IN ('derived_from','packaged_from','compiled_from','verified_against','supersedes','contains','extracted_from','normalized_from','compared_with')),
  invocation_id           TEXT,
  metadata                TEXT,
  created_at              TEXT NOT NULL DEFAULT (to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  PRIMARY KEY (source_artifact_id, destination_artifact_id, relationship)
);

CREATE TABLE IF NOT EXISTS artifact_verifications (
  verification_id  TEXT PRIMARY KEY,
  artifact_id      TEXT NOT NULL REFERENCES artifacts_v2(artifact_id),
  artifact_type    TEXT NOT NULL,
  observed_digest  TEXT NOT NULL,
  verifier_name    TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('passed','failed')),
  checks_json      TEXT,
  invocation_id    TEXT,
  created_at       TEXT NOT NULL DEFAULT (to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE TABLE IF NOT EXISTS artifact_events (
  event_id     TEXT PRIMARY KEY,
  artifact_id  TEXT NOT NULL REFERENCES artifacts_v2(artifact_id),
  prior_state  TEXT,
  next_state   TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  invocation_id TEXT,
  reason       TEXT,
  metadata     TEXT,
  created_at   TEXT NOT NULL DEFAULT (to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

-- Migrate existing artifacts records if the old table exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'artifacts') THEN
    INSERT INTO artifacts_v2 (
      artifact_id, invocation_id, canonical_path, content_digest, byte_count, state, provenance, retention_policy
    )
    SELECT artifact_id, invocation_id, path, digest, size_bytes, 'finalized', 'imported', 'imported_external'
    FROM artifacts
    ON CONFLICT (artifact_id) DO NOTHING;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_artifacts_v2_invocation ON artifacts_v2(invocation_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_v2_state ON artifacts_v2(state);
CREATE INDEX IF NOT EXISTS idx_artifacts_v2_type ON artifacts_v2(artifact_type);
CREATE INDEX IF NOT EXISTS idx_artifacts_v2_path ON artifacts_v2(canonical_path);
CREATE INDEX IF NOT EXISTS idx_artifacts_v2_digest ON artifacts_v2(content_digest);
CREATE INDEX IF NOT EXISTS idx_artifacts_v2_created ON artifacts_v2(created_at);
CREATE INDEX IF NOT EXISTS idx_artifact_events_artifact ON artifact_events(artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifact_verifications_artifact ON artifact_verifications(artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifact_relationships_src ON artifact_relationships(source_artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifact_relationships_dst ON artifact_relationships(destination_artifact_id);
