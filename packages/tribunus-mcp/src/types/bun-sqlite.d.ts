declare module "bun:sqlite" {
  interface DatabaseOptions {
    readonly?: boolean
    create?: boolean
  }

  interface Statement {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown | null
    run(...params: unknown[]): { changes: number }
  }

  class Database {
    constructor(path: string, opts?: DatabaseOptions)
    query(sql: string): Statement
    run(sql: string, ...params: unknown[]): { changes: number }
    prepare(sql: string): Statement
    close(): void
  }
}
