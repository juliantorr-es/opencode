import { sha256Hex, digestIfPresent } from "../shared/digests.js"
import * as crypto from "node:crypto"

export interface InvocationReceipt {
  invocation_id: string
  tool: string
  version: string
  start: string
  end: string
  duration_ms: number
  success: boolean
  timeout: boolean
  exit_code: number | null
  signal: string | null
  stdout_digest: string | null
  stderr_digest: string | null
  created_paths: string[]
  modified_paths: string[]
  output_digests: Record<string, string>
  env_policy_digest: string
  errors: string[]
}

export interface FinalizeReceiptInput {
  success: boolean
  timeout: boolean
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  created: string[]
  modified: string[]
  outputDigests: Record<string, string>
  errors: string[]
}

export function makeReceipt(tool: string, envPolicyDigest: string): {
  receipt: InvocationReceipt
  finalize: (result: FinalizeReceiptInput) => InvocationReceipt
} {
  const start = new Date().toISOString()
  const receipt: InvocationReceipt = {
    invocation_id: crypto.randomUUID(),
    tool,
    version: "0.4.0",
    start,
    end: "",
    duration_ms: 0,
    success: false,
    timeout: false,
    exit_code: null,
    signal: null,
    stdout_digest: null,
    stderr_digest: null,
    created_paths: [],
    modified_paths: [],
    output_digests: {},
    env_policy_digest: envPolicyDigest,
    errors: [],
  }
  return {
    receipt,
    finalize: (result) => {
      receipt.end = new Date().toISOString()
      receipt.duration_ms = Date.now() - new Date(start).getTime()
      receipt.success = result.success
      receipt.timeout = result.timeout
      receipt.exit_code = result.exitCode
      receipt.signal = result.signal
      receipt.stdout_digest = digestIfPresent(result.stdout)
      receipt.stderr_digest = digestIfPresent(result.stderr)
      receipt.created_paths = result.created
      receipt.modified_paths = result.modified
      receipt.output_digests = result.outputDigests
      receipt.errors = result.errors
      return receipt
    },
  }
}
