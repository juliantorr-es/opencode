/**
 * Audit Export and Verification Tool
 *
 * Exports audit trails in standard formats (JSON, CSV, canonical).
 * Includes a manifest with SHA-256 checksums for every exported record.
 * Verification tool validates manifest against exported data and confirms
 * chain integrity — no access to the live system required.
 *
 * Usage:
 *   bun run packages/opencode/src/capability/audit-export.ts --format json --output audit-export/
 *   bun run packages/opencode/src/capability/audit-export.ts --verify audit-export/
 */
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

// ── Export Record Types ──────────────────────────────────────────────────────

interface AuditRecord {
  id: string
  timestamp: number
  entityType: string
  entityId: string
  action: string
  actor: string
  outcome: string
  evidenceRef: string | null
  previousReceiptId: string | null
  receiptHash: string
}

interface ExportManifest {
  format: string
  exportedAt: string
  totalRecords: number
  firstTimestamp: number
  lastTimestamp: number
  records: Array<{
    id: string
    checksum: string
    lineNumber: number
  }>
  manifestChecksum: string
  exporterVersion: string
}

interface VerificationReport {
  valid: boolean
  totalRecords: number
  checksumsMatched: number
  checksumsFailed: number
  chainIntegrityValid: boolean
  chainBreaks: string[]
  manifestValid: boolean
  errors: string[]
}

// ── Query Existing Receipts ──────────────────────────────────────────────────

function queryAuditRecords(): AuditRecord[] {
  // In production, queries CapabilityAuthorityReceiptTable and RecoveryReceiptTable via PGlite.
  // For bootstrap, returns an empty array — the export tool is scaffolded.
  return []
}

// ── SHA-256 Checksum ────────────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex")
}

function recordChecksum(record: AuditRecord): string {
  return sha256(
    `${record.id}:${record.timestamp}:${record.entityType}:${record.entityId}:${record.action}:${record.outcome}:${record.receiptHash}`
  )
}

// ── Export: JSON ─────────────────────────────────────────────────────────────

function exportJSON(records: AuditRecord[], outputDir: string): string {
  const jsonPath = path.join(outputDir, "audit-records.json")
  const json = JSON.stringify(records, null, 2) + "\n"
  fs.writeFileSync(jsonPath, json)
  return jsonPath
}

// ── Export: CSV ──────────────────────────────────────────────────────────────

function exportCSV(records: AuditRecord[], outputDir: string): string {
  const csvPath = path.join(outputDir, "audit-records.csv")
  const header = "id,timestamp,entityType,entityId,action,actor,outcome,evidenceRef,previousReceiptId,receiptHash\n"
  const rows = records.map((r) =>
    [
      r.id,
      r.timestamp,
      r.entityType,
      r.entityId,
      r.action,
      r.actor,
      r.outcome,
      r.evidenceRef ?? "",
      r.previousReceiptId ?? "",
      r.receiptHash,
    ].join(",")
  )
  fs.writeFileSync(csvPath, header + rows.join("\n") + "\n")
  return csvPath
}

// ── Export: Canonical ─────────────────────────────────────────────────────────

function exportCanonical(records: AuditRecord[], outputDir: string): string {
  const canonicalPath = path.join(outputDir, "audit-records.canonical.json")
  const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
  const canonical = {
    format: "tribunus-audit-canonical-v1",
    exportedAt: new Date().toISOString(),
    records: sorted.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      entityType: r.entityType,
      entityId: r.entityId,
      action: r.action,
      actor: r.actor,
      outcome: r.outcome,
      evidenceRef: r.evidenceRef,
      previousReceiptId: r.previousReceiptId,
      receiptHash: r.receiptHash,
      checksum: recordChecksum(r),
    })),
  }
  fs.writeFileSync(canonicalPath, JSON.stringify(canonical, null, 2) + "\n")
  return canonicalPath
}

// ── Export: Manifest ─────────────────────────────────────────────────────────

function generateManifest(
  records: AuditRecord[],
  format: string
): ExportManifest {
  const sortedByTimestamp = [...records].sort((a, b) => a.timestamp - b.timestamp)
  const recordEntries = sortedByTimestamp.map((r, i) => ({
    id: r.id,
    checksum: recordChecksum(r),
    lineNumber: i + 1,
  }))

  const manifest: ExportManifest = {
    format,
    exportedAt: new Date().toISOString(),
    totalRecords: records.length,
    firstTimestamp: sortedByTimestamp[0]?.timestamp ?? 0,
    lastTimestamp: sortedByTimestamp[sortedByTimestamp.length - 1]?.timestamp ?? 0,
    records: recordEntries,
    manifestChecksum: "",
    exporterVersion: "1.0.0",
  }

  // Self-checksum: hash the manifest without its own checksum field
  const { manifestChecksum: _, ...manifestWithoutChecksum } = manifest
  manifest.manifestChecksum = sha256(JSON.stringify(manifestWithoutChecksum, Object.keys(manifestWithoutChecksum).sort()))

  return manifest
}

function writeManifest(manifest: ExportManifest, outputDir: string): string {
  const manifestPath = path.join(outputDir, "manifest.json")
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
  return manifestPath
}

// ── Verification ──────────────────────────────────────────────────────────────

function verifyExport(outputDir: string): VerificationReport {
  const report: VerificationReport = {
    valid: true,
    totalRecords: 0,
    checksumsMatched: 0,
    checksumsFailed: 0,
    chainIntegrityValid: true,
    chainBreaks: [],
    manifestValid: true,
    errors: [],
  }

  // Load manifest
  const manifestPath = path.join(outputDir, "manifest.json")
  if (!fs.existsSync(manifestPath)) {
    report.valid = false
    report.manifestValid = false
    report.errors.push("manifest.json not found")
    return report
  }

  const manifest: ExportManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
  report.totalRecords = manifest.totalRecords

  // Verify manifest self-checksum
  const { manifestChecksum: storedChecksum, ...manifestRest } = manifest
  const recomputedChecksum = sha256(JSON.stringify(manifestRest, Object.keys({ ...manifestRest }).sort()))
  if (recomputedChecksum !== storedChecksum) {
    report.valid = false
    report.manifestValid = false
    report.errors.push(`Manifest checksum mismatch: stored=${storedChecksum} recomputed=${recomputedChecksum}`)
  }

  // Load canonical export
  const canonicalPath = path.join(outputDir, "audit-records.canonical.json")
  if (!fs.existsSync(canonicalPath)) {
    report.valid = false
    report.errors.push("audit-records.canonical.json not found")
    return report
  }

  const canonical: { records: AuditRecord[] } = JSON.parse(fs.readFileSync(canonicalPath, "utf-8"))
  const records = canonical.records

  // Verify record count matches manifest
  if (records.length !== manifest.totalRecords) {
    report.valid = false
    report.errors.push(`Record count mismatch: manifest=${manifest.totalRecords} actual=${records.length}`)
  }

  // Verify each record's checksum against manifest
  for (const record of records) {
    const manifestEntry = manifest.records.find((e) => e.id === record.id)
    if (!manifestEntry) {
      report.checksumsFailed++
      report.errors.push(`Record ${record.id} not found in manifest`)
      continue
    }
    const computed = recordChecksum(record)
    if (computed !== manifestEntry.checksum) {
      report.checksumsFailed++
      report.errors.push(`Checksum mismatch for ${record.id}: manifest=${manifestEntry.checksum} computed=${computed}`)
    } else {
      report.checksumsMatched++
    }
  }

  // Verify chain integrity — every receipt's previousReceiptId must reference an existing receipt
  const receiptIds = new Set(records.map((r) => r.id))
  for (const record of records) {
    if (record.previousReceiptId && !receiptIds.has(record.previousReceiptId)) {
      report.chainIntegrityValid = false
      report.chainBreaks.push(
        `Chain break: receipt ${record.id} references ${record.previousReceiptId} which is not in the export`
      )
    }
  }

  if (report.chainBreaks.length === 0) {
    report.chainBreaks.push("chain integrity verified — no breaks found")
  }

  report.valid =
    report.manifestValid &&
    report.checksumsFailed === 0 &&
    report.chainIntegrityValid

  return report
}

// ── Main Export Function ─────────────────────────────────────────────────────

function runExport(outputDir: string, format: string) {
  fs.mkdirSync(outputDir, { recursive: true })

  const records = queryAuditRecords()
  const files: string[] = []

  files.push(exportJSON(records, outputDir))
  files.push(exportCSV(records, outputDir))
  files.push(exportCanonical(records, outputDir))

  const manifest = generateManifest(records, format)
  files.push(writeManifest(manifest, outputDir))

  console.log(`Exported ${records.length} audit records to ${outputDir}:`)
  for (const f of files) {
    console.log(`  ${f}`)
  }
  console.log(`Manifest checksum: ${manifest.manifestChecksum}`)
}

// ── CLI Entry Point ──────────────────────────────────────────────────────────

if (typeof Bun !== "undefined" && import.meta.main) {
  const args = process.argv.slice(2)

  if (args.includes("--verify")) {
    const dir = args[args.indexOf("--verify") + 1] ?? "audit-export"
    const report = verifyExport(dir)
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.valid ? 0 : 1)
  }

  const format = args.includes("--format") ? args[args.indexOf("--format") + 1] : "all"
  const output = args.includes("--output") ? args[args.indexOf("--output") + 1] : "audit-export"

  runExport(output, format)
}
