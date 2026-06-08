#!/usr/bin/env bun
/**
 * Tribunus Memory Authority Tools
 * Custom Oh My Pi tools for governed, bank-scoped memory operations.
 * These tools wrap Mnemopi with Tribunus-shaped contracts.
 * 
 * Contract: Every operation returns a receipt proving logical bank, physical path, and operation status.
 * Doctrine: No authority claim without observable backing.
 */

import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, existsSync, rmSync } from "node:fs";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const MNEMOPI_CLI = resolve(PROJECT_ROOT, "node_modules/@oh-my-pi/pi-mnemopi/src/cli.ts");
const DEFAULT_BASE_DIR = join(homedir(), ".hermes", "mnemopi", "data");

// ============================================================================
// TYPES
// ============================================================================

interface Receipt {
  success: boolean;
  operation: string;
  logicalBank: string;
  physicalDataDir: string;
  physicalDbPath: string;
  timestamp: string;
  error?: string;
}

interface MemoryReceipt extends Receipt {
  memoryId?: string;
  content?: string;
}

interface RecallReceipt extends Receipt {
  query: string;
  results: Array<{
    id: string;
    content: string;
    score: number;
  }>;
}

interface IsolationCheckReceipt extends Receipt {
  sentinelId: string;
  writeBank: string;
  recallFromWriteBank: boolean;
  recallFromOtherBank: boolean;
  otherBank: string;
  sentinelContentHash?: string;
  cleanupStatus?: "cleaned" | "skipped" | "failed";
}

// ============================================================================
// Mnemopi Execution Helper (Single source of truth)
// ============================================================================

/**
 * Mnemopi command execution result with strict typing
 */
interface MnemopiExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  success: boolean;
  error?: string;
}

/**
 * Strict Mnemopi execution helper
 * Distinguishes: command failure, parse failure, empty success, successful recall
 */
async function executeMnemopi(
  bank: string,
  command: string,
  args: string[],
  baseDir: string = DEFAULT_BASE_DIR
): Promise<MnemopiExecResult> {
  const resolved = resolveBankPath(bank, baseDir);
  
  // Validate bank directory exists
  if (!existsSync(resolved.dataDir)) {
    return {
      stdout: "",
      stderr: `Bank directory does not exist: ${resolved.dataDir}`,
      exitCode: null,
      success: false,
      error: `MISSING_BANK_DIR: ${resolved.dataDir}`,
    };
  }

  // Validate DB file exists (for non-default banks)
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

  // Non-zero exit is a hard failure, not empty results
  if (exitCode !== 0) {
    return {
      stdout,
      stderr,
      exitCode,
      success: false,
      error: `NON_ZERO_EXIT: exitCode=${exitCode}, stderr=${stderr.trim()}`,
    };
  }

  // Check for error patterns in stderr
  if (stderr && stderr.includes("error:") || stderr.includes("Error:")) {
    return {
      stdout,
      stderr,
      exitCode,
      success: false,
      error: `COMMAND_ERROR: ${stderr.trim()}`,
    };
  }

  return {
    stdout,
    stderr,
    exitCode,
    success: true,
  };
}

// ============================================================================
// BANK RESOLUTION
// ============================================================================

function resolveBankPath(bank: string, baseDir: string = DEFAULT_BASE_DIR): { dataDir: string; dbPath: string } {
  if (bank === "default") {
    return {
      dataDir: baseDir,
      dbPath: join(baseDir, "mnemopi.db"),
    };
  }
  return {
    dataDir: join(baseDir, "banks", bank),
    dbPath: join(baseDir, "banks", bank, "mnemopi.db"),
  };
}

function generateReceipt(
  operation: string,
  bank: string,
  baseDir: string,
  success: boolean,
  error?: string,
  extras: Record<string, unknown> = {}
): Receipt {
  const resolved = resolveBankPath(bank, baseDir);
  return {
    success,
    operation,
    logicalBank: bank,
    physicalDataDir: resolved.dataDir,
    physicalDbPath: resolved.dbPath,
    timestamp: new Date().toISOString(),
    error,
    ...extras,
  };
}

// ============================================================================
// BANK OPERATIONS
// ============================================================================

function listBanksFromFs(baseDir: string = DEFAULT_BASE_DIR): string[] {
  const banks: string[] = ["default"];
  const banksDir = join(baseDir, "banks");
  
  if (existsSync(banksDir)) {
    try {
      const entries = readdirSync(banksDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== "default") {
          banks.push(entry.name);
        }
      }
    } catch {
      // Ignore errors reading banks directory
    }
  }
  
  return banks.sort();
}

// ============================================================================
// PARSE HELPERS
// ============================================================================

function parseRecallOutput(output: string): Array<{ id: string; content: string; score: number }> {
  const results: Array<{ id: string; content: string; score: number }> = [];
  const lines = output.split("\n");

  let currentId = "";
  let currentContent = "";
  let currentScore = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("ID:")) {
      if (currentId) {
        results.push({ id: currentId, content: currentContent, score: currentScore });
      }
      currentId = trimmed.replace("ID:", "").trim();
      currentContent = "";
      currentScore = 0;
    } else if (trimmed.startsWith("Score:")) {
      currentScore = parseFloat(trimmed.replace("Score:", "").trim()) || 0;
    } else if (trimmed.startsWith("Content:")) {
      currentContent = trimmed.replace("Content:", "").trim();
    } else if (trimmed && !trimmed.startsWith("Results for:") && currentId) {
      currentContent = currentContent ? `${currentContent} ${trimmed}` : trimmed;
    }
  }

  if (currentId) {
    results.push({ id: currentId, content: currentContent, score: currentScore });
  }

  return results;
}

function parseRememberOutput(output: string): string | null {
  const match = output.match(/Stored:\s*([a-f0-9]+)/i);
  return match ? match[1] : null;
}

function hashContent(content: string): string {
  // Simple hash for sentinel content identification
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `0x${Math.abs(hash).toString(16)}`;
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

function isValidBank(bank: string, baseDir: string = DEFAULT_BASE_DIR): boolean {
  if (bank === "default") return true;
  const resolved = resolveBankPath(bank, baseDir);
  return existsSync(resolved.dataDir) && existsSync(resolved.dbPath);
}

// ============================================================================
// CORE TOOLS
// ============================================================================

export async function tribunusMemoryRemember(
  bank: string,
  content: string,
  options: {
    source?: string;
    importance?: number;
    scope?: string;
    veracity?: string;
    baseDir?: string;
    cleanupOnFailure?: boolean;
  } = {}
): Promise<MemoryReceipt> {
  const { source = "user", importance = 0.5, scope = "global", veracity = "stated", baseDir = DEFAULT_BASE_DIR, cleanupOnFailure = false } = options;
  
  // Validate bank exists
  if (!isValidBank(bank, baseDir)) {
    return generateReceipt(
      "remember",
      bank,
      baseDir,
      false,
      `INVALID_BANK: Bank '${bank}' does not exist or is not accessible`,
      { content }
    ) as MemoryReceipt;
  }
  
  try {
    const execResult = await executeMnemopi(bank, "remember", [
      content,
      source,
      String(importance),
    ], baseDir);

    if (!execResult.success) {
      return generateReceipt(
        "remember",
        bank,
        baseDir,
        false,
        execResult.error || `Mnemopi execution failed: ${execResult.stderr}`,
        { content }
      ) as MemoryReceipt;
    }

    const memoryId = parseRememberOutput(execResult.stdout);
    if (!memoryId) {
      // This is a parse failure, not empty success
      return generateReceipt(
        "remember",
        bank,
        baseDir,
        false,
        `PARSE_FAILURE: Could not extract memory ID from output`,
        { content, stdout: execResult.stdout }
      ) as MemoryReceipt;
    }

    return generateReceipt(
      "remember",
      bank,
      baseDir,
      true,
      undefined,
      { memoryId, content }
    ) as MemoryReceipt;
  } catch (error) {
    return generateReceipt(
      "remember",
      bank,
      baseDir,
      false,
      String(error),
      { content }
    ) as MemoryReceipt;
  }
}

export async function tribunusMemoryRecall(
  bank: string,
  query: string,
  topK: number = 5,
  baseDir: string = DEFAULT_BASE_DIR
): Promise<RecallReceipt> {
  // Validate bank exists
  if (!isValidBank(bank, baseDir)) {
    return generateReceipt(
      "recall",
      bank,
      baseDir,
      false,
      `INVALID_BANK: Bank '${bank}' does not exist or is not accessible`,
      { query, results: [] }
    ) as RecallReceipt;
  }

  try {
    const execResult = await executeMnemopi(bank, "recall", [query, String(topK)], baseDir);

    if (!execResult.success) {
      return generateReceipt(
        "recall",
        bank,
        baseDir,
        false,
        execResult.error || `Mnemopi execution failed: ${execResult.stderr}`,
        { query, results: [] }
      ) as RecallReceipt;
    }

    // Validate output is parseable
    try {
      const results = parseRecallOutput(execResult.stdout);
      return generateReceipt(
        "recall",
        bank,
        baseDir,
        true,
        undefined,
        { query, results }
      ) as RecallReceipt;
    } catch (parseError) {
      return generateReceipt(
        "recall",
        bank,
        baseDir,
        false,
        `PARSE_FAILURE: ${String(parseError)}`,
        { query, results: [], stdout: execResult.stdout }
      ) as RecallReceipt;
    }
  } catch (error) {
    return generateReceipt(
      "recall",
      bank,
      baseDir,
      false,
      String(error),
      { query, results: [] }
    ) as RecallReceipt;
  }
}

export async function tribunusMemoryIsolationCheck(
  writeBank: string,
  readBank: string,
  baseDir: string = DEFAULT_BASE_DIR,
  cleanup: boolean = true
): Promise<IsolationCheckReceipt> {
  // Validate both banks exist
  if (!isValidBank(writeBank, baseDir)) {
    return generateReceipt(
      "isolation_check",
      writeBank,
      baseDir,
      false,
      `INVALID_BANK: Write bank '${writeBank}' does not exist or is not accessible`,
      { sentinelId: "N/A", writeBank, recallFromWriteBank: false, recallFromOtherBank: false, otherBank: readBank, cleanupStatus: "skipped" }
    ) as IsolationCheckReceipt;
  }
  
  if (!isValidBank(readBank, baseDir)) {
    return generateReceipt(
      "isolation_check",
      writeBank,
      baseDir,
      false,
      `INVALID_BANK: Read bank '${readBank}' does not exist or is not accessible`,
      { sentinelId: "N/A", writeBank, recallFromWriteBank: false, recallFromOtherBank: false, otherBank: readBank, cleanupStatus: "skipped" }
    ) as IsolationCheckReceipt;
  }

  // Generate unique sentinel with test marker
  const sentinelContent = `ISOLATION_CHECK_SENTINEL_${Date.now()}_${Math.random().toString(36).slice(2)}_TEST_DATA`;
  const contentHash = hashContent(sentinelContent);
  
  // Step 1: Write sentinel to writeBank
  const writeReceipt = await tribunusMemoryRemember(writeBank, sentinelContent, {
    source: "isolation-check",
    importance: 0.01, // Low importance, clearly test data
    baseDir,
    cleanupOnFailure: true,
  });

  if (!writeReceipt.success || !writeReceipt.memoryId) {
    return generateReceipt(
      "isolation_check",
      writeBank,
      baseDir,
      false,
      `FAILED_TO_WRITE_SENTINEL: ${writeReceipt.error}`,
      { sentinelId: "N/A", writeBank, recallFromWriteBank: false, recallFromOtherBank: false, otherBank: readBank, cleanupStatus: "skipped" }
    ) as IsolationCheckReceipt;
  }

  const sentinelId = writeReceipt.memoryId;

  try {
    // Step 2: Recall from writeBank (should find sentinel)
    const recallFromWrite = await tribunusMemoryRecall(writeBank, sentinelContent, 1, baseDir);
    const foundInWrite = recallFromWrite.results.some(r => r.content.includes(sentinelContent));

    // Step 3: Recall from readBank (should NOT find sentinel)
    const recallFromRead = await tribunusMemoryRecall(readBank, sentinelContent, 1, baseDir);
    const foundInRead = recallFromRead.results.some(r => r.content.includes(sentinelContent));

    const success = foundInWrite && !foundInRead;
    const error = !success ? `ISOLATION_VIOLATED: foundInWrite=${foundInWrite}, foundInRead=${foundInRead}` : undefined;

    // Cleanup: remove sentinel from writeBank
    let cleanupStatus: "cleaned" | "skipped" | "failed" = "skipped";
    if (cleanup && writeBank !== "default") {
      try {
        // Use mnemopi CLI to forget the sentinel
        const forgetResult = await executeMnemopi(writeBank, "forget", [sentinelId], baseDir);
        if (forgetResult.success) {
          cleanupStatus = "cleaned";
        } else {
          cleanupStatus = "failed";
        }
      } catch {
        cleanupStatus = "failed";
      }
    }

    return generateReceipt(
      "isolation_check",
      writeBank,
      baseDir,
      success,
      error,
      {
        sentinelId,
        writeBank,
        recallFromWriteBank: foundInWrite,
        recallFromOtherBank: foundInRead,
        otherBank: readBank,
        sentinelContentHash: contentHash,
        cleanupStatus,
      }
    ) as IsolationCheckReceipt;
  } catch (error) {
    return generateReceipt(
      "isolation_check",
      writeBank,
      baseDir,
      false,
      `ISOLATION_CHECK_ERROR: ${String(error)}`,
      { sentinelId, writeBank, recallFromWriteBank: false, recallFromOtherBank: false, otherBank: readBank, cleanupStatus: "skipped" }
    ) as IsolationCheckReceipt;
  }
}

export async function tribunusMemoryBankList(baseDir: string = DEFAULT_BASE_DIR): Promise<string[]> {
  return listBanksFromFs(baseDir);
}

export async function tribunusMemoryBankCreate(
  bank: string,
  baseDir: string = DEFAULT_BASE_DIR
): Promise<Receipt> {
  try {
    const { stdout, stderr, exitCode, success, error } = await executeMnemopi("default", "bank", ["create", bank], baseDir);
    
    if (!success) {
      return generateReceipt("bank_create", bank, baseDir, false, error || stderr);
    }
    
    return generateReceipt("bank_create", bank, baseDir, true);
  } catch (error) {
    return generateReceipt("bank_create", bank, baseDir, false, String(error));
  }
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

async function main() {
  const args = Bun.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: bun run scripts/tribunus_memory.ts <command> [args]");
    console.error("Commands: remember, recall, isolation_check, bank_list, bank_create");
    process.exit(1);
  }

  const command = args[0];
  const rest = args.slice(1);

  try {
    switch (command) {
      case "remember": {
        if (rest.length < 2) {
          console.error("Usage: remember <bank> <content> [source] [importance]");
          process.exit(1);
        }
        const receipt = await tribunusMemoryRemember(
          rest[0],
          rest.slice(1, -2).join(" "),
          { source: rest[rest.length - 2], importance: rest[rest.length - 1] ? parseFloat(rest[rest.length - 1]) : 0.5 }
        );
        console.log(JSON.stringify(receipt, null, 2));
        break;
      }

      case "recall": {
        if (rest.length < 2) {
          console.error("Usage: recall <bank> <query> [top_k]");
          process.exit(1);
        }
        const receipt = await tribunusMemoryRecall(
          rest[0],
          rest[1],
          rest[2] ? parseInt(rest[2]) : 5
        );
        console.log(JSON.stringify(receipt, null, 2));
        break;
      }

      case "isolation_check": {
        if (rest.length < 2) {
          console.error("Usage: isolation_check <write_bank> <read_bank> [cleanup=true]");
          process.exit(1);
        }
        const cleanup = rest[2] !== "false" && rest[2] !== "0";
        const receipt = await tribunusMemoryIsolationCheck(rest[0], rest[1], undefined, cleanup);
        console.log(JSON.stringify(receipt, null, 2));
        break;
      }

      case "bank_list": {
        const banks = await tribunusMemoryBankList();
        console.log(JSON.stringify({ banks }, null, 2));
        break;
      }

      case "bank_create": {
        if (rest.length < 1) {
          console.error("Usage: bank_create <bank_name>");
          process.exit(1);
        }
        const receipt = await tribunusMemoryBankCreate(rest[0]);
        console.log(JSON.stringify(receipt, null, 2));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
