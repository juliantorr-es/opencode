// ── DuckDB SQL Firewall (defense-in-depth) ────────────────
// Pure-function module with no Effect dependency.
// Importable from both Effect and non-Effect code paths.
// The -readonly subprocess flag provides the primary defense;
// this is an extra application-layer gate.

export const BLOCKED_FUNCTIONS = [
  "read_text",
  "read_blob",
  "read_csv",
  "read_parquet",
  "read_json",
  "query_table",
  "ATTACH",
  "load_extension",
  "LOAD",
  "EXPORT",
] as const

export class DuckDBFirewallError extends Error {
  readonly _tag = "DuckDBFirewallError"
  constructor(message: string) {
    super(message)
    this.name = "DuckDBFirewallError"
  }
}

export function checkSQLFirewall(sql: string): void {
  // Strip block comments, single-line comments, and string literal content
  sql = sql.replace(/\/\*[\s\S]*?\*\//g, "")           // /* ... */
  sql = sql.replace(/--.*$/gm, "")                      // -- single line
  sql = sql.replace(/'[^']*'/g, "''")                   // 'string literals'
  sql = sql.replace(/"[^"]*"/g, "\"\"")                 // "identifier literals"
  const upper = sql.toUpperCase()

  // Check blocked function names (case-insensitive substring match)
  for (const fn of BLOCKED_FUNCTIONS) {
    if (upper.includes(fn.toUpperCase())) {
      throw new DuckDBFirewallError(
        `Blocked dangerous DuckDB function or command: "${fn}" is not allowed in read-only queries`,
      )
    }
  }

  // Check for COPY … TO pattern (statement-level command)
  const copyIdx = upper.indexOf("COPY")
  if (copyIdx !== -1 && upper.indexOf("TO", copyIdx + 4) !== -1) {
    throw new DuckDBFirewallError(
      "Blocked dangerous DuckDB command: COPY … TO is not allowed in read-only queries",
    )
  }
}
