// ─── Secret scanning for tool output ────────────────────────────────────
// Post-processes tool stdout/stderr for secrets before returning to agent
// context. Reuses VALUE_SECRET_PATTERNS from debug-packet.ts (authority).
//
// Canonical pattern authority: packages/opencode/src/debug/debug-packet.ts:147
// Keep patterns synchronized with that file.

/** A single secret finding in tool output */
export interface SecretFinding {
  label: string
  found: boolean
  sample?: string
}

/** Scan result returned by SecretScanner.scan() */
export interface SecretScanResult {
  findings: SecretFinding[]
  redacted: string
  hadSecrets: boolean
}

// ─── Regex patterns (mirror debug-packet.ts:147-155) ──────────────────

const VALUE_SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/ },
  { label: "API key", pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{20,}\b/ },
  { label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

const MAX_SCAN_BYTES = 10240

/**
 * Scan tool output for secrets. Returns redacted text + structured findings.
 * Non-blocking: secrets are detected but the output is returned (with
 * findings metadata). The caller decides whether to block, warn, or log.
 */
export function scanToolOutput(text: string): SecretScanResult {
  const findings: SecretFinding[] = []
  let hadSecrets = false

  const head = text.slice(0, MAX_SCAN_BYTES)

  for (const { label, pattern } of VALUE_SECRET_PATTERNS) {
    const match = pattern.exec(head)
    if (match) {
      hadSecrets = true
      findings.push({
        label,
        found: true,
        sample: match[0].slice(0, 32),
      })
    }
  }

  // Redact the scanned portion
  let redacted = head
  for (const { pattern } of VALUE_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => `[REDACTED:${match.slice(0, 8)}...]`)
  }
  if (text.length > MAX_SCAN_BYTES) {
    redacted += text.slice(MAX_SCAN_BYTES)
  }

  return { findings, redacted, hadSecrets }
}

/** Quick check: does text contain any known secret patterns? */
export function hasSecrets(text: string): boolean {
  const head = text.slice(0, MAX_SCAN_BYTES)
  return VALUE_SECRET_PATTERNS.some(({ pattern }) => pattern.test(head))
}
