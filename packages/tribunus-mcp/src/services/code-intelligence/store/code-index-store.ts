import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { getCodeIntelligenceMigrationDir } from "../../config.js"
import type { PGliteConstructor, PGliteLike } from "../../store/pglite-runtime.js"
import { loadPGliteConstructor } from "../../store/pglite-runtime.js"
import type {
  CodeAuthorityFlowRecordV1,
  CodeFileRecordV1,
  CodeFindingRecordV1,
  CodeImportRecordV1,
  CodeIndexEventRecordV1,
  CodeIndexSnapshotRecordV1,
  CodeIndexSnapshotV1,
  CodeManifestRecordV1,
  CodeReferenceRecordV1,
  CodeSymbolRecordV1,
  CodeTestRecordV1,
} from "./code-index-types.js"
import { createCodeIndexContext, ensureCodeIndexStateDir, readSnapshotFile, writeSnapshotFile } from "../indexer-context.js"

const MIGRATION_FILES = [
  "0001_code_files.sql",
  "0002_symbols_imports_references.sql",
  "0003_tests_findings_snapshots.sql",
  "0004_authority_flows.sql",
  "0005_review_packets.sql",
  "0006_import_resolution_statuses.sql",
  "0007_authority_flow_symbol_ids.sql",
  "0008_finding_symbol_ids.sql",
]

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v === undefined ? null : v), 2)
}

function getNow(): string {
  return new Date().toISOString()
}

function tableRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => JSON.parse(JSON.stringify(row)) as T)
}

export class CodeIndexStoreV1 {
  private db: PGliteLike | null = null
  private dbCtor: PGliteConstructor | null = null
  private latestSnapshot: CodeIndexSnapshotV1 | null = null

  constructor(private readonly repoRoot: string) {}

  get context() {
    return createCodeIndexContext(this.repoRoot)
  }

  private async ensureDb(): Promise<PGliteLike> {
    if (this.db) return this.db
    const ctx = this.context
    ensureCodeIndexStateDir(ctx)
    if (!this.dbCtor) {
      this.dbCtor = await loadPGliteConstructor(this.repoRoot)
    }
    this.db = new this.dbCtor(ctx.dbDir)
    return this.db
  }

  async migrate(): Promise<void> {
    const db = await this.ensureDb()
    const migrationDir = getCodeIntelligenceMigrationDir()
    for (const file of MIGRATION_FILES) {
      const sqlPath = resolve(migrationDir, file)
      if (!existsSync(sqlPath)) continue
      await db.exec(readFileSync(sqlPath, "utf8"))
    }
  }

  async loadSnapshot(): Promise<CodeIndexSnapshotV1 | null> {
    if (this.latestSnapshot) return this.latestSnapshot
    const snapshot = readSnapshotFile(this.context)
    if (snapshot) {
      this.latestSnapshot = snapshot
      return snapshot
    }
    return null
  }

  async saveSnapshot(snapshot: CodeIndexSnapshotV1): Promise<void> {
    const db = await this.ensureDb()
    await this.migrate()

    await db.exec("BEGIN")
    try {
      for (const statement of [
        "DELETE FROM code_review_packets",
        "DELETE FROM code_index_events",
        "DELETE FROM code_authority_flows",
        "DELETE FROM code_tests",
        "DELETE FROM code_findings",
        "DELETE FROM code_references",
        "DELETE FROM code_imports",
        "DELETE FROM code_manifests",
        "DELETE FROM code_symbols",
        "DELETE FROM code_files",
        "DELETE FROM code_index_snapshots",
      ]) {
        await db.exec(statement)
      }

      for (const file of tableRows(snapshot.file_index)) {
        await db.query(
          `INSERT INTO code_files (
            file_id, path, language, category, sha256, size_bytes, line_count,
            importance, inclusion_status, parse_status, parse_error, indexed_at, last_seen_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            file.file_id,
            file.path,
            file.language ?? null,
            file.category,
            file.sha256,
            file.size_bytes,
            file.line_count ?? null,
            file.importance,
            file.inclusion_status,
            file.parse_status,
            file.parse_error ?? null,
            file.indexed_at,
            file.last_seen_at,
          ],
        )
      }

      for (const symbol of tableRows(snapshot.symbol_index)) {
        await db.query(
          `INSERT INTO code_symbols (
            symbol_id, file_id, name, kind, exported, start_line, end_line, start_byte, end_byte,
            signature, doc_summary, authority_role, symbol_hash, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            symbol.symbol_id,
            symbol.file_id,
            symbol.name,
            symbol.kind,
            symbol.exported,
            symbol.start_line ?? null,
            symbol.end_line ?? null,
            symbol.start_byte ?? null,
            symbol.end_byte ?? null,
            symbol.signature ?? null,
            symbol.doc_summary ?? null,
            symbol.authority_role ?? null,
            symbol.symbol_hash ?? null,
            symbol.created_at,
          ],
        )
      }

      for (const imp of tableRows(snapshot.imports)) {
        await db.query(
          `INSERT INTO code_imports (
            import_id, from_file_id, specifier, import_kind, resolution_status,
            resolved_file_id, resolved_path, reason, start_line, end_line
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            imp.import_id,
            imp.from_file_id,
            imp.specifier,
            imp.import_kind,
            imp.resolution_status,
            imp.resolved_file_id ?? null,
            imp.resolved_path ?? null,
            imp.reason ?? null,
            imp.start_line ?? null,
            imp.end_line ?? null,
          ],
        )
      }

      for (const ref of tableRows(snapshot.references)) {
        await db.query(
          `INSERT INTO code_references (
            reference_id, from_file_id, from_symbol_id, to_symbol_id, reference_kind,
            start_line, end_line, confidence
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            ref.reference_id,
            ref.from_file_id,
            ref.from_symbol_id ?? null,
            ref.to_symbol_id ?? null,
            ref.reference_kind,
            ref.start_line ?? null,
            ref.end_line ?? null,
            ref.confidence,
          ],
        )
      }

      for (const test of tableRows(snapshot.tests)) {
        await db.query(
          `INSERT INTO code_tests (
            test_id, file_id, suite_name, test_name, framework, target_file_id, target_symbol_id,
            assertion_kind, start_line, end_line, confidence
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            test.test_id,
            test.file_id,
            test.suite_name ?? null,
            test.test_name,
            test.framework,
            test.target_file_id ?? null,
            test.target_symbol_id ?? null,
            test.assertion_kind ?? null,
            test.start_line ?? null,
            test.end_line ?? null,
            test.confidence,
          ],
        )
      }

      for (const flow of tableRows(snapshot.authority_flows)) {
        await db.query(
          `INSERT INTO code_authority_flows (
            flow_id, tool_id, file_id, flow_step, detected, symbol_id, start_line, end_line, confidence, notes
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            flow.flow_id,
            flow.tool_id,
            flow.file_id,
            flow.flow_step,
            flow.detected,
            flow.symbol_id ?? null,
            flow.start_line ?? null,
            flow.end_line ?? null,
            flow.confidence,
            flow.notes ?? null,
          ],
        )
      }

      const fileIds = new Set(snapshot.file_index.map((file) => file.file_id))
      for (const manifest of tableRows(snapshot.manifests).filter((entry) => fileIds.has(entry.file_id))) {
        await db.query(
          `INSERT INTO code_manifests (
            manifest_id, file_id, manifest_kind, subject_id, version, risk_level, requires_active_session,
            requires_hash_precondition, requires_path_lock, requires_approval, side_effects_json, raw_json
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            manifest.manifest_id,
            manifest.file_id,
            manifest.manifest_kind,
            manifest.subject_id,
            manifest.version ?? null,
            manifest.risk_level ?? null,
            manifest.requires_active_session ?? null,
            manifest.requires_hash_precondition ?? null,
            manifest.requires_path_lock ?? null,
            manifest.requires_approval ?? null,
            stableJson(manifest.side_effects_json),
            stableJson(manifest.raw_json),
          ],
        )
      }

      for (const finding of tableRows(snapshot.findings)) {
        await db.query(
          `INSERT INTO code_findings (
            finding_id, severity, category, message, path, symbol_id, source_anchor_json, recommended_fix, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            finding.finding_id,
            finding.severity,
            finding.category,
            finding.message,
            finding.path ?? null,
            finding.symbol_id ?? null,
            finding.source_anchor_json ? stableJson(finding.source_anchor_json) : null,
            finding.recommended_fix ?? null,
            finding.created_at,
          ],
        )
      }

      await db.query(
        `INSERT INTO code_index_snapshots (
          snapshot_id, created_at, git_sha, git_branch, dirty, file_count, parsed_file_count,
          symbol_count, import_count, reference_count, test_count, finding_count,
          semantic_packet_path, source_packet_path
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          snapshot.snapshot_id,
          snapshot.created_at,
          snapshot.git_sha ?? null,
          snapshot.git_branch ?? null,
          snapshot.dirty,
          snapshot.file_index.length,
          snapshot.file_index.filter((file) => file.parse_status === "parsed").length,
          snapshot.symbol_index.length,
          snapshot.imports.length,
          snapshot.references.length,
          snapshot.tests.length,
          snapshot.findings.length,
          snapshot.semantic_packet_path ?? null,
          snapshot.source_packet_path ?? null,
        ],
      )

      for (const event of tableRows(snapshot.events)) {
        await db.query(
          `INSERT INTO code_index_events (
            event_id, snapshot_id, event_type, path, payload_json, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            event.event_id,
            event.snapshot_id ?? snapshot.snapshot_id,
            event.event_type,
            event.path ?? null,
            stableJson(event.payload_json),
            event.created_at,
          ],
        )
      }

      await db.exec("COMMIT")
      this.latestSnapshot = snapshot
      writeSnapshotFile(this.context, snapshot)
    } catch (error) {
      await db.exec("ROLLBACK")
      throw error
    }
  }

  async recordPacket(input: {
    snapshot_id: string
    packet_kind: "semantic" | "source" | "paired"
    zip_path: string
    zip_sha256: string
    warnings: string[]
  }): Promise<void> {
    const db = await this.ensureDb()
    await this.migrate()
    await db.query(
      `INSERT INTO code_review_packets (
        packet_id, snapshot_id, packet_kind, zip_path, zip_sha256, warnings_json
      ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        `packet:${input.packet_kind}:${input.snapshot_id}`,
        input.snapshot_id,
        input.packet_kind,
        input.zip_path,
        input.zip_sha256,
        stableJson(input.warnings),
      ],
    )
  }

  async loadSnapshotFromDiskOrDb(): Promise<CodeIndexSnapshotV1 | null> {
    const fromDisk = readSnapshotFile(this.context)
    if (fromDisk) {
      this.latestSnapshot = fromDisk
      return fromDisk
    }
    const db = await this.ensureDb()
    await this.migrate()
    const result = await db.query(`SELECT * FROM code_index_snapshots ORDER BY created_at DESC LIMIT 1`)
    const row = (result.rows?.[0] as Record<string, unknown> | undefined) ?? null
    if (!row) return null
    return this.latestSnapshot
  }

  async latestCounts(): Promise<CodeIndexSnapshotRecordV1 | null> {
    const db = await this.ensureDb()
    await this.migrate()
    const result = await db.query(`SELECT * FROM code_index_snapshots ORDER BY created_at DESC LIMIT 1`)
    return (result.rows?.[0] as CodeIndexSnapshotRecordV1 | undefined) ?? null
  }
}

const storeCache = new Map<string, CodeIndexStoreV1>()

export function getCodeIndexStore(repoRoot: string): CodeIndexStoreV1 {
  let store = storeCache.get(repoRoot)
  if (!store) {
    store = new CodeIndexStoreV1(repoRoot)
    storeCache.set(repoRoot, store)
  }
  return store
}
