/**
 * Migration Executor — every migration SQL statement goes through this.
 * Known idempotent DDL collisions are classified as notices.
 * Unknown errors still fail startup.
 * No fire-and-forget promises — every statement is awaited through this executor.
 */

export interface MigrationNotice {
  kind: "idempotent_ddl_notice"
  sqlState: string
  message: string
  statement: string
}

function sqlStateOf(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>
    if (typeof e.code === "string") return e.code
    if (typeof e.sqlState === "string") return e.sqlState
  }
  return undefined
}

function isKnownIdempotentDdl(error: unknown, statement: string): MigrationNotice | undefined {
  // Check SQLSTATE codes with clause-specific matching
  const sqlState = sqlStateOf(error)
  if (sqlState) {
    const normalized = statement.toLowerCase()
    const codeMatch =
      (sqlState === "42701" && normalized.includes("add column")) ||
      (sqlState === "42P07" && normalized.includes("create table")) ||
      (sqlState === "42P16" && normalized.includes("alter table"))
    if (codeMatch) {
      return {
        kind: "idempotent_ddl_notice",
        sqlState,
        message: error instanceof Error ? error.message : String(error),
        statement,
      }
    }
  }

  // Fallback: message pattern checks for drivers that don't report SQLSTATE codes
  if (error instanceof Error || (typeof error === "object" && error !== null)) {
    const msg = (error as Record<string, unknown>).message as string | undefined ?? ""
    if (/already exists/.test(msg) || /duplicate (column|table|relation)/i.test(msg)) {
      return {
        kind: "idempotent_ddl_notice",
        sqlState: sqlState ?? "unknown",
        message: msg,
        statement,
      }
    }
  }

  return undefined
}

export async function executeMigrationStatement(
  exec: (statement: string) => Promise<unknown>,
  statement: string,
): Promise<{ status: "applied" } | { status: "notice"; notice: MigrationNotice }> {
  try {
    await exec(statement)
    return { status: "applied" }
  } catch (error) {
    const notice = isKnownIdempotentDdl(error, statement)
    if (notice) {
      console.debug("[migration] idempotent DDL notice:", notice.sqlState, notice.statement.slice(0, 80))
      return { status: "notice", notice }
    }
    throw error
  }
}

export async function executeMigrations(
  statements: string[],
  exec: (statement: string) => Promise<unknown>,
): Promise<MigrationNotice[]> {
  const notices: MigrationNotice[] = []
  for (const statement of statements) {
    const result = await executeMigrationStatement(exec, statement)
    if (result.status === "notice") {
      notices.push(result.notice)
    }
  }
  return notices
}
