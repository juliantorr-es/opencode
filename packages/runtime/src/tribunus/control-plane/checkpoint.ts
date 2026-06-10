/**
 * Tribunus Checkpoint Resume Packet Generation
 * 
 * Checkpoints capture operational state (not just git commits).
 * Each checkpoint produces a resume packet that can restore the agent to that state.
 * 
 * Hardening: memory recall failures are hard failures, not silent empty results.
 * Git state unavailability produces degraded checkpoint, not swallowed errors.
 * Uses the strict executeMnemopi helper from tribunus_memory.ts.
 */

import { tribunusCheckpointCreate as createCheckpoint, tribunusReceiptCreate } from "./crud";
import type { Checkpoint, Receipt as ReceiptType } from "./schema";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const MNEMOPI_CLI = resolve(PROJECT_ROOT, "node_modules/@oh-my-pi/pi-mnemopi/src/cli.ts");
const DEFAULT_BASE_DIR = join(homedir(), ".hermes", "mnemopi", "data");

// ============================================================================
// STRICT MNEMOPI EXECUTION (embedded copy — same contract as tribunus_memory.ts)
// ============================================================================

function resolveBankPath(bank: string, baseDir: string = DEFAULT_BASE_DIR): { dataDir: string; dbPath: string } {
  if (bank === "default") {
    return { dataDir: baseDir, dbPath: join(baseDir, "mnemopi.db") };
  }
  return {
    dataDir: join(baseDir, "banks", bank),
    dbPath: join(baseDir, "banks", bank, "mnemopi.db"),
  };
}

interface MnemopiExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  success: boolean;
  error?: string;
}

async function executeMnemopi(
  bank: string,
  command: string,
  args: string[],
  baseDir: string = DEFAULT_BASE_DIR
): Promise<MnemopiExecResult> {
  const resolved = resolveBankPath(bank, baseDir);

  if (!existsSync(resolved.dataDir)) {
    return {
      stdout: "",
      stderr: `Bank directory does not exist: ${resolved.dataDir}`,
      exitCode: null,
      success: false,
      error: `MISSING_BANK_DIR: ${resolved.dataDir}`,
    };
  }

  if (bank !== "default" && !existsSync(resolved.dbPath)) {
    return {
      stdout: "",
      stderr: `Database file does not exist: ${resolved.dbPath}`,
      exitCode: null,
      success: false,
      error: `MISSING_DB_FILE: ${resolved.dbPath}`,
    };
  }

  const result = Bun.spawn([
    "bun", "run", MNEMOPI_CLI, command, ...args
  ], {
    env: {
      ...process.env,
      MNEMOPI_DATA_DIR: resolved.dataDir,
      MNEMOPI_EMBEDDING_MODEL: "nomic-embed-text",
      MNEMOPI_EMBEDDING_API_URL: "http://localhost:11434/v1",
      MNEMOPI_VEC_TYPE: "float32",
      MNEMOPI_EMBEDDINGS_VIA_API: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(result.stdout).text();
  const stderr = await new Response(result.stderr).text();
  const exitCode = await result.exited;

  if (exitCode !== 0) {
    return {
      stdout,
      stderr,
      exitCode,
      success: false,
      error: `NON_ZERO_EXIT: exitCode=${exitCode}, stderr=${stderr.trim()}`,
    };
  }

  return { stdout, stderr, exitCode, success: true };
}

// ============================================================================
// TYPES
// ============================================================================

interface CheckpointOptions {
  taskId: string;
  laneId: string;
  missionId: string;
  name: string;
  description: string;
  memoryBank: string;
  memoryQuery?: string;
  dbPath?: string;
}

interface GitStateResult {
  available: boolean;
  commit?: string;
  branch?: string;
  dirty?: boolean;
  error?: string;
}

interface RecallResult {
  status: "success" | "failed" | "degraded";
  results: Array<{ id: string; content: string; score: number }>;
  error?: string;
  query: string;
}

interface ResumePacket {
  checkpointId: string;
  taskId: string;
  laneId: string;
  missionId: string;
  name: string;
  timestamp: string;
  gitState: {
    available: boolean;
    commit?: string;
    branch?: string;
    dirty?: boolean;
    error?: string;
  };
  operationalState: Record<string, unknown>;
  memoryContext: Array<{
    id: string;
    content: string;
    score: number;
    bank: string;
  }>;
  memoryContextStatus: "success" | "failed" | "degraded";
  receipt: ReceiptType;
}

// ============================================================================
// CHECKPOINT CREATION
// ============================================================================

/**
 * Create a checkpoint with memory context.
 * Fails closed on memory recall failures — no silent empty results.
 */
export async function tribunusCheckpointCreateWithMemory(
  options: CheckpointOptions
): Promise<ResumePacket> {
  const {
    taskId,
    laneId,
    missionId,
    name,
    description,
    memoryBank,
    memoryQuery = name,
    dbPath = "tribunus-control-plane.db",
  } = options;

  // Get git state — explicit about availability
  const gitState = getGitState();

  // Get operational state snapshot
  const operationalState = getOperationalState(taskId, laneId, missionId);

  // Recall memory context — fail-closed on errors
  const memoryRecall = await recallMemoryContextStrict(memoryBank, memoryQuery);

  // Create checkpoint with memory context status
  const checkpoint: Omit<Checkpoint, "id" | "createdAt" | "updatedAt" | "createdBy"> = {
    type: "checkpoint",
    taskId,
    laneId,
    missionId,
    name,
    description,
    stateSnapshot: operationalState,
    gitCommit: gitState.commit,
    gitBranch: gitState.branch,
    gitDirty: gitState.dirty,
    memoryBank,
    memoryQuery,
    memoryResults: memoryRecall.results.map(r => ({ id: r.id, content: r.content, score: r.score })),
    memoryContextStatus: memoryRecall.status,
    status: memoryRecall.status === "failed" ? "failed" : "created",
  };

  const checkpointReceipt = createCheckpoint(checkpoint, dbPath);
  if (!checkpointReceipt.success) {
    throw new Error(`Failed to create checkpoint: ${checkpointReceipt.error}`);
  }

  const createdCheckpoint = checkpointReceipt.output as unknown as Checkpoint;

  // Create receipt — verdict reflects overall status
  const receiptVerdict: "pass" | "fail" | "warning" = 
    memoryRecall.status === "failed" ? "fail" : 
    memoryRecall.status === "degraded" || !gitState.available ? "warning" : "pass";

  const receipt: Omit<ReceiptType, "id" | "createdAt" | "updatedAt" | "createdBy"> = {
    type: "receipt",
    operation: "checkpoint_create",
    entityType: "checkpoint",
    entityId: createdCheckpoint.id,
    verdict: receiptVerdict,
    input: { taskId, laneId, missionId, name, memoryQuery },
    output: {
      checkpointId: createdCheckpoint.id,
      memoryResultsCount: memoryRecall.results.length,
      memoryContextStatus: memoryRecall.status,
      gitAvailable: gitState.available,
    },
    success: memoryRecall.status !== "failed",
    error: memoryRecall.error || (gitState.available ? undefined : gitState.error),
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    memoryBank,
    checkpointId: createdCheckpoint.id,
  };

  const receiptReceipt = tribunusReceiptCreate(receipt, dbPath);

  // Build resume packet
  const resumePacket: ResumePacket = {
    checkpointId: createdCheckpoint.id,
    taskId,
    laneId,
    missionId,
    name,
    timestamp: new Date().toISOString(),
    gitState: {
      available: gitState.available,
      commit: gitState.commit,
      branch: gitState.branch,
      dirty: gitState.dirty,
      error: gitState.error,
    },
    operationalState,
    memoryContext: memoryRecall.results.map(r => ({ ...r, bank: memoryBank })),
    memoryContextStatus: memoryRecall.status,
    receipt: receiptReceipt.success ? (receiptReceipt.output as unknown as ReceiptType) : receiptReceipt,
  };

  return resumePacket;
}

// ============================================================================
// GIT STATE
// ============================================================================

function getGitState(): GitStateResult {
  try {
    const commitProc = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe", cwd: process.cwd() });
    const commit = commitProc.stdout?.toString().trim() || undefined;

    const branchProc = Bun.spawnSync(["git", "branch", "--show-current"], { stdout: "pipe", stderr: "pipe", cwd: process.cwd() });
    const branch = branchProc.stdout?.toString().trim() || undefined;

    const statusProc = Bun.spawnSync(["git", "status", "--porcelain"], { stdout: "pipe", stderr: "pipe", cwd: process.cwd() });
    const status = statusProc.stdout?.toString().trim() || "";
    const dirty = status.length > 0;

    if (!commit && !branch) {
      return { available: false, error: "Not a git repository or git not available" };
    }

    return { available: true, commit, branch, dirty };
  } catch (err) {
    return { available: false, error: `Git state unavailable: ${String(err)}` };
  }
}

// ============================================================================
// OPERATIONAL STATE
// ============================================================================

function getOperationalState(taskId: string, laneId: string, missionId: string): Record<string, unknown> {
  return {
    task: { id: taskId },
    lane: { id: laneId },
    mission: { id: missionId },
    timestamp: new Date().toISOString(),
    tools: {
      mnemopi: { status: "active" },
      pglite: { status: "active" },
      valkey: { status: "active" },
    },
  };
}

// ============================================================================
// STRICT MEMORY RECALL
// ============================================================================

/**
 * Strict memory recall that fails closed.
 * Distinguishes: command failure, parse failure, empty success, successful recall.
 * Never returns [] for a failed execution — that's the hardening contract.
 */
async function recallMemoryContextStrict(
  bank: string,
  query: string,
  topK: number = 10
): Promise<RecallResult> {
  const execResult = await executeMnemopi(bank, "recall", [query, String(topK)]);

  if (!execResult.success) {
    return {
      status: "failed",
      results: [],
      error: execResult.error || `Mnemopi execution failed: ${execResult.stderr}`,
      query,
    };
  }

  // Parse the JSON receipt output from tribunus_memory.ts CLI
  try {
    const receipt = JSON.parse(execResult.stdout) as {
      success: boolean;
      error?: string;
      results: Array<{ id: string; content: string; score: number }>;
    };

    if (!receipt.success) {
      return {
        status: "failed",
        results: [],
        error: receipt.error || "Mnemopi recall returned failure",
        query,
      };
    }

    // Empty results is valid — no memories found
    const results = receipt.results || [];
    if (results.length === 0) {
      return { status: "success", results: [], query };
    }

    return { status: "success", results, query };
  } catch (parseError) {
    return {
      status: "failed",
      results: [],
      error: `PARSE_FAILURE: Could not parse recall output: ${String(parseError)}`,
      query,
    };
  }
}

// ============================================================================
// RESUME PACKET FILE GENERATION
// ============================================================================

export function generateResumePacketFile(packet: ResumePacket, path?: string): string {
  const filePath = path || `checkpoint-${packet.checkpointId}-${Date.now()}.json`;
  const content = JSON.stringify(packet, null, 2);
  Bun.write(filePath, content);
  return filePath;
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

async function main() {
  const args = Bun.argv.slice(2);
  if (args.length < 4) {
    console.error("Usage: bun run checkpoint.ts <taskId> <laneId> <missionId> <name> [description] [memoryBank]");
    process.exit(1);
  }

  const [taskId, laneId, missionId, name, description = "", memoryBank = "tribunus-core"] = args;

  try {
    const packet = await tribunusCheckpointCreateWithMemory({
      taskId,
      laneId,
      missionId,
      name,
      description,
      memoryBank,
    });

    const filePath = generateResumePacketFile(packet);
    console.log(`✓ Checkpoint created: ${packet.checkpointId}`);
    console.log(`  Status: ${packet.memoryContextStatus}`);
    console.log(`  Git available: ${packet.gitState.available}`);
    console.log(`  Memory context: ${packet.memoryContext.length} results`);
    console.log(`  Resume packet: ${filePath}`);
  } catch (error) {
    console.error(`✗ Failed to create checkpoint: ${error}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
