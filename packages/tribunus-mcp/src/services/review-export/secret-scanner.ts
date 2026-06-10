/**
 * Secret Scanner — mandatory redaction stage before review export finalization.
 * Scans staged contents, manifests, diffs, and config-like files for secrets.
 * Fails closed if any high-confidence secret is found.
 */

const HIGH_CONFIDENCE_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "hf_token", regex: /hf_[A-Za-z0-9]{34}/ },
  { name: "github_token", regex: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "openai_key", regex: /sk-[A-Za-z0-9]{32,}/ },
  { name: "jwt_private_key", regex: /-----BEGIN RSA PRIVATE KEY-----/ },
  { name: "jwt_private_key_ec", regex: /-----BEGIN EC PRIVATE KEY-----/ },
]

const LOW_CONFIDENCE_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "generic_token", regex: /\b[A-Za-z0-9_\-]{20,}token\b/i },
  { name: "api_key_assignment", regex: /\b(?:api[_-]?key|apikey|secret)\s*[:=]\s*['"][^'"]{8,}['"]/i },
]

export interface SecretScanResult {
  passed: boolean
  highConfidence: Array<{ pattern: string; file: string; line: number; match: string }>
  lowConfidence: Array<{ pattern: string; file: string; line: number; match: string }>
}

export function scanForSecrets(
  content: string,
  fileName: string,
  existingHighConfidence: SecretScanResult["highConfidence"],
  existingLowConfidence: SecretScanResult["lowConfidence"],
): void {
  for (const pattern of HIGH_CONFIDENCE_PATTERNS) {
    let match: RegExpExecArray | null
    while ((match = pattern.regex.exec(content)) !== null) {
      const line = content.slice(0, match.index).split("\n").length
      existingHighConfidence.push({
        pattern: pattern.name,
        file: fileName,
        line,
        match: match[0].slice(0, 40), // truncate in report
      })
    }
  }
  for (const pattern of LOW_CONFIDENCE_PATTERNS) {
    let match: RegExpExecArray | null
    while ((match = pattern.regex.exec(content)) !== null) {
      const line = content.slice(0, match.index).split("\n").length
      existingLowConfidence.push({
        pattern: pattern.name,
        file: fileName,
        line,
        match: match[0].slice(0, 40),
      })
    }
  }
}
