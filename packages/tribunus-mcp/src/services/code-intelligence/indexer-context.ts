import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { getCodeIntelligenceDir, getCodeIntelligenceDbDir } from "../config.js"
import type { CodeIndexSnapshotV1 } from "./store/code-index-types.js"

export type CodeIndexContextV1 = {
  repoRoot: string
  stateDir: string
  dbDir: string
  snapshotPath: string
  semanticPacketPath: string
  sourcePacketPath: string
}

export function createCodeIndexContext(repoRoot: string): CodeIndexContextV1 {
  const stateDir = getCodeIntelligenceDir()
  const dbDir = getCodeIntelligenceDbDir()
  return {
    repoRoot,
    stateDir,
    dbDir,
    snapshotPath: resolve(stateDir, "latest-snapshot.json"),
    semanticPacketPath: resolve(repoRoot, "tribunus-semantic-review.zip"),
    sourcePacketPath: resolve(repoRoot, "tribunus-source-review.zip"),
  }
}

export function ensureCodeIndexStateDir(ctx: CodeIndexContextV1): void {
  if (!existsSync(ctx.stateDir)) mkdirSync(ctx.stateDir, { recursive: true })
  if (!existsSync(ctx.dbDir)) mkdirSync(ctx.dbDir, { recursive: true })
}

export function writeSnapshotFile(ctx: CodeIndexContextV1, snapshot: CodeIndexSnapshotV1): void {
  ensureCodeIndexStateDir(ctx)
  writeFileSync(ctx.snapshotPath, JSON.stringify(snapshot, null, 2), "utf8")
}

export function readSnapshotFile(ctx: CodeIndexContextV1): CodeIndexSnapshotV1 | null {
  if (!existsSync(ctx.snapshotPath)) return null
  return JSON.parse(readFileSync(ctx.snapshotPath, "utf8")) as CodeIndexSnapshotV1
}
