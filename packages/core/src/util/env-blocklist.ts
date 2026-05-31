const ENV_BLOCKLIST = new Set([
  'OPENCODE_AUTH_CONTENT', 'OPENCODE_AUTH_TOKEN', 'OPENCODE_GITHUB_TOKEN',
  'GITHUB_TOKEN', 'GITHUB_ACCESS_TOKEN', 'GIT_ASKPASS',
  'NPM_TOKEN', 'NPM_AUTH_TOKEN', 'NPM_CONFIG__AUTH',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK', 'OPENCODE_STORAGE_ACCESS_KEY_ID',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY',
  'HUGGINGFACE_API_KEY', 'REPLICATE_API_KEY', 'TOGETHER_API_KEY',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'AZURE_OPENAI_KEY',
  'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY',
  'PERPLEXITY_API_KEY', 'CO_API_KEY',
  'NEXUS_API_KEY', 'NETLIFY_AUTH_TOKEN', 'VERCEL_TOKEN',
  'SUPABASE_KEY', 'DATABASE_URL',
])

export function isBlocklistedEnvVar(name: string): boolean {
  if (ENV_BLOCKLIST.has(name)) return true
  const upper = name.toUpperCase()
  if (upper.endsWith('_TOKEN') || upper.endsWith('_KEY') || upper.endsWith('_SECRET') || upper.endsWith('_PASSWORD') || upper.endsWith('_CREDENTIAL') || upper.endsWith('_API_KEY')) return true
  return false
}

export function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !isBlocklistedEnvVar(key)) {
      result[key] = value
    }
  }
  return result
}
