import { randomBytes } from "node:crypto"
import { sha256 } from "./hashing.js"

export type ReceiptId = string

export function createInvocationId(): string {
  const ts = new Date().toISOString().replace(/[:-]/g, "").replace(/\..+/, "Z")
  return `omp_inv_${ts}_${randomBytes(4).toString("hex")}`
}

export function createReceiptId(
  tool: string,
  sessionId: string,
  targetPaths: string[],
  beforeHash: string,
  afterHash: string,
): ReceiptId {
  const ts = new Date()
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\..+/, "Z")
  const input = [tool, sessionId, ts, ...targetPaths, beforeHash, afterHash].join("|")
  return `omp_${tool}_${ts}_${sha256(input).slice(0, 8)}`
}

export function createEventId(): string {
  const ts = new Date().toISOString().replace(/[:-]/g, "").replace(/\..+/, "Z")
  return `omp_evt_${ts}_${randomBytes(4).toString("hex")}`
}

export function createJournalId(receiptId: string): string {
  return `omp_jrn_${receiptId}`
}

