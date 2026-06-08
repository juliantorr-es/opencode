// Redact common secret patterns from command output.
// Conservative by design — only redacts patterns with high signal.

const patterns: Array<[RegExp, string]> = [
  // OpenAI API keys
  [/sk-[A-Za-z0-9_-]{20,}/g, "sk-***REDACTED***"],
  // Anthropic API keys
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "sk-ant-***REDACTED***"],
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  [/gh[pousr]_[A-Za-z0-9]{36,}/g, "gh*_***REDACTED***"],
  // Generic bearer tokens in Authorization headers
  [/Authorization:\s*Bearer\s+\S+/gi, "Authorization: Bearer ***REDACTED***"],
  // AWS access key IDs (AKIA...)
  [/AKIA[0-9A-Z]{16}/g, "AKIA***REDACTED***"],
  // Stripe secret keys (sk_live_, sk_test_)
  [/sk_(?:live|test)_[A-Za-z0-9]{24,}/g, "sk_***REDACTED***"],
  // Generic apiKey= patterns
  [/[?&](?:api_key|apikey|api-key|token|secret|password)=[^&\s]+/gi, (_match: string) => {
    const key = _match.slice(0, _match.indexOf("=") + 1)
    return `${key}***REDACTED***`
  }],
]

export function redactSecrets(text: string): string {
  let result = text
  for (const [pattern, replacement] of patterns) {
    result = result.replace(pattern, replacement as string)
  }
  return result
}
