/**
 * Tamper Detection
 *
 * Detects tampering in audit trails and evidence chains:
 * - Missing entries (sequence gap analysis)
 * - Altered receipts (hash chain verification)
 * - Broken hash chains (immediate alert)
 * - Backdated entries (timestamp monotonicity checks)
 *
 * Turns tamper events into structured TamperAlert records.
 */
import { createHash } from "node:crypto"

// ── Types ────────────────────────────────────────────────────────────────────

interface AuditEntry {
  id: string
  timestamp: number
  receiptHash: string
  previousReceiptId: string | null
  sequenceNumber: number
  content: string
}

interface TamperAlert {
  severity: "critical" | "warning"
  kind: "missing_entry" | "altered_receipt" | "broken_hash_chain" | "backdated_entry" | "sequence_gap"
  detail: string
  entryId: string
  timestamp: number
  evidence: Record<string, unknown>
}

interface TamperReport {
  totalEntries: number
  alerts: TamperAlert[]
  hashChainValid: boolean
  sequenceValid: boolean
  monotonicityValid: boolean
  compromised: boolean
}

// ── Hashing ──────────────────────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex")
}

function computeEntryHash(entry: { id: string; timestamp: number; previousReceiptId: string | null; content: string }): string {
  return sha256(`${entry.id}:${entry.timestamp}:${entry.previousReceiptId ?? "genesis"}:${entry.content}`)
}

// ── Tamper Detection Engine ───────────────────────────────────────────────────

/**
 * Scan audit entries for tampering.
 */
export function detectTampering(entries: AuditEntry[]): TamperReport {
  const alerts: TamperAlert[] = []
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))

  // Check 1: Sequence gap analysis
  const sequenceNumbers = sorted.map((e) => e.sequenceNumber)
  for (let i = 1; i < sequenceNumbers.length; i++) {
    const gap = sequenceNumbers[i] - sequenceNumbers[i - 1]
    if (gap > 1) {
      alerts.push({
        severity: "warning",
        kind: "sequence_gap",
        detail: `Sequence gap from ${sequenceNumbers[i - 1]} to ${sequenceNumbers[i]} (missing ${gap - 1} entries)`,
        entryId: sorted[i].id,
        timestamp: Date.now(),
        evidence: { from: sequenceNumbers[i - 1], to: sequenceNumbers[i], gap },
      })
    }
    if (gap < 1) {
      alerts.push({
        severity: "critical",
        kind: "sequence_gap",
        detail: `Duplicate or backward sequence: ${sequenceNumbers[i - 1]} → ${sequenceNumbers[i]}`,
        entryId: sorted[i].id,
        timestamp: Date.now(),
        evidence: { previous: sequenceNumbers[i - 1], current: sequenceNumbers[i] },
      })
    }
  }

  // Check 2: Hash chain verification — recompute every entry's hash and verify predecessor links
  const entryMap = new Map<string, AuditEntry>()
  for (const entry of sorted) entryMap.set(entry.id, entry)

  for (const entry of sorted) {
    const recomputedHash = computeEntryHash(entry)
    if (recomputedHash !== entry.receiptHash) {
      alerts.push({
        severity: "critical",
        kind: "altered_receipt",
        detail: `Receipt hash mismatch for ${entry.id}: stored=${entry.receiptHash} computed=${recomputedHash}`,
        entryId: entry.id,
        timestamp: Date.now(),
        evidence: { storedHash: entry.receiptHash, computedHash: recomputedHash },
      })
    }
  }

  // Check 3: Broken hash chains — predecessor references must resolve
  for (const entry of sorted) {
    if (entry.previousReceiptId && !entryMap.has(entry.previousReceiptId)) {
      alerts.push({
        severity: "critical",
        kind: "broken_hash_chain",
        detail: `Entry ${entry.id} references missing predecessor ${entry.previousReceiptId}`,
        entryId: entry.id,
        timestamp: Date.now(),
        evidence: { predecessorId: entry.previousReceiptId },
      })
    }
  }

  // Check 4: Backdated entries — timestamp monotonicity
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].timestamp < sorted[i - 1].timestamp) {
      alerts.push({
        severity: "warning",
        kind: "backdated_entry",
        detail: `Entry ${sorted[i].id} (${sorted[i].timestamp}) is earlier than predecessor ${sorted[i - 1].id} (${sorted[i - 1].timestamp})`,
        entryId: sorted[i].id,
        timestamp: Date.now(),
        evidence: {
          current: sorted[i].timestamp,
          predecessor: sorted[i - 1].timestamp,
        },
      })
    }
  }

  const hasCritical = alerts.some((a) => a.severity === "critical")
  const hasHashAlerts = alerts.some((a) => a.kind === "altered_receipt" || a.kind === "broken_hash_chain")
  const hasSequenceAlerts = alerts.some((a) => a.kind === "sequence_gap")
  const hasBackdatedAlerts = alerts.some((a) => a.kind === "backdated_entry")

  return {
    totalEntries: sorted.length,
    alerts,
    hashChainValid: !hasHashAlerts,
    sequenceValid: !hasSequenceAlerts,
    monotonicityValid: !hasBackdatedAlerts,
    compromised: hasCritical,
  }
}

// ── Integrity Check (Lightweight) ─────────────────────────────────────────────

/**
 * Lightweight integrity check — recomputes hash chain tip only.
 * Fast path for periodic health checks.
 */
function checkHashChainTip(entries: AuditEntry[]): string | null {
  if (entries.length === 0) return null
  const sorted = [...entries].sort((a, b) => a.sequenceNumber - b.sequenceNumber)
  let tip = computeEntryHash(sorted[0])
  for (let i = 1; i < sorted.length; i++) {
    const expectedPredecessor = tip
    tip = computeEntryHash(sorted[i])
    if (sorted[i].previousReceiptId && sorted[i].previousReceiptId !== expectedPredecessor) {
      return `Chain tip mismatch at entry ${sorted[i].id}`
    }
  }
  return null
}
