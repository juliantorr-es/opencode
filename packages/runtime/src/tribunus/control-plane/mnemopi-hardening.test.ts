/**
 * Tribunus Hardening Gate — Mnemopi Execution & Bank Isolation Tests
 *
 * Doctrine: no authority claim without observable backing.
 * Every test tries to BREAK a claim about Mnemopi operations.
 * The desired outcome is not "throws" — it's "fails closed with a typed
 * failure receipt that the caller cannot confuse with success."
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  tribunusMemoryRecall,
  tribunusMemoryRemember,
  tribunusMemoryIsolationCheck,
  tribunusMemoryBankList,
  tribunusMemoryBankCreate,
} from "../../../../../scripts/tribunus_memory";

// ============================================================================
// DOMAIN 1: Mnemopi Execution Hardening
//     Every call returns a receipt, never an untyped throw.
//     Invalid banks fail closed. Empty results ≠ failure.
// ============================================================================

describe("Mnemopi Execution Hardening", () => {
  test("tribunusMemoryRecall with nonexistent bank returns success=false with INVALID_BANK error", async () => {
    const receipt = await tribunusMemoryRecall("definitely-does-not-exist-12345", "test query");
    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain("INVALID_BANK");
  });

  test("tribunusMemoryRecall with nonexistent bank directory returns success=false", async () => {
    // Use a bank name whose dataDir and dbPath don't exist on filesystem
    const receipt = await tribunusMemoryRecall("nonexistent-bank-on-fs-xyz", "test query");
    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain("INVALID_BANK");
  });

  test("tribunusMemoryRecall with bank='default' returns valid receipt with logicalBank/physicalDataDir/physicalDbPath fields", async () => {
    const receipt = await tribunusMemoryRecall("default", "test query for structural check");
    expect(receipt.operation).toBe("recall");
    expect(receipt.logicalBank).toBe("default");
    expect(receipt.physicalDataDir).toBeTruthy();
    expect(typeof receipt.physicalDataDir).toBe("string");
    expect(receipt.physicalDbPath).toBeTruthy();
    expect(typeof receipt.physicalDbPath).toBe("string");
    expect(receipt.timestamp).toBeTruthy();
    expect(typeof receipt.timestamp).toBe("string");
    // query and results are RecallReceipt-specific fields
    expect(receipt.query).toBe("test query for structural check");
    expect(Array.isArray(receipt.results)).toBe(true);
  });

  test("tribunusMemoryRemember with nonexistent bank returns success=false", async () => {
    const receipt = await tribunusMemoryRemember("bank-that-does-not-exist-xyz", "test content");
    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain("INVALID_BANK");
  });

  test("recall receipt distinguishes empty success vs failure", async () => {
    // Recall with a unique query — will match nothing
    const receipt = await tribunusMemoryRecall("default", `zzz-unique-nonexistent-${Date.now()}`);
    // results is always an array, never null/undefined
    expect(Array.isArray(receipt.results)).toBe(true);
    if (receipt.success) {
      // Genuine empty success: no matches found, but operation succeeded
      expect(receipt.results.length).toBe(0);
      expect(receipt.error).toBeUndefined();
    } else {
      // Operation failed (e.g. mnemopi CLI unavailable):
      // results is still [] (never undefined), and error is set
      expect(receipt.results.length).toBe(0);
      expect(receipt.error).toBeTruthy();
      expect(typeof receipt.error).toBe("string");
    }
  });
});

// ============================================================================
// DOMAIN 2: Bank Isolation Hardening
//     Banks are independent memory namespaces.
//     Sentinels written to bank A must not leak into bank B.
// ============================================================================

describe("Bank Isolation Hardening", () => {
  const testBankName = `test-bank-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let secondBankAvailable = false;

  beforeAll(async () => {
    const createReceipt = await tribunusMemoryBankCreate(testBankName);
    secondBankAvailable = createReceipt.success;
  });

  afterAll(async () => {
    // Best-effort cleanup: attempt to remove the test bank directory.
    // We don't import rm/rimraf here — leave filesystem artifacts rather
    // than risk corrupting another test run's assertions.
  });

  test("tribunusMemoryIsolationCheck with invalid write bank returns success=false", async () => {
    const receipt = await tribunusMemoryIsolationCheck(
      "nonexistent-write-bank",
      "default",
    );
    expect(receipt.success).toBe(false);
    expect(receipt.error || "").toContain("INVALID_BANK");
  });

  test("tribunusMemoryIsolationCheck with valid banks", async () => {
    if (!secondBankAvailable) {
      // Second bank creation failed (no mnemopi CLI, no FS permissions, etc.)
      // Skip — isolation requires two real banks to measure leakage.
      return;
    }
    const receipt = await tribunusMemoryIsolationCheck("default", testBankName);
    // Successful isolation: sentinel written to "default" is found there
    // but NOT recalled from testBankName
    expect(receipt.success).toBe(true);
    expect(receipt.sentinelId).toBeTruthy();
    expect(typeof receipt.sentinelId).toBe("string");
    expect(receipt.recallFromWriteBank).toBe(true);
    expect(receipt.recallFromOtherBank).toBe(false);
  });

  test("isolation receipt includes sentinelId, writeBank, otherBank, recallFromWriteBank, recallFromOtherBank, contentHash, cleanupStatus", async () => {
    if (!secondBankAvailable) {
      return;
    }
    const receipt = await tribunusMemoryIsolationCheck("default", testBankName);
    expect(receipt.sentinelId).toBeTruthy();
    expect(receipt.writeBank).toBe("default");
    expect(receipt.otherBank).toBe(testBankName);
    expect(typeof receipt.recallFromWriteBank).toBe("boolean");
    expect(typeof receipt.recallFromOtherBank).toBe("boolean");
    // sentinelContentHash is set on the happy path
    if (receipt.success) {
      expect(receipt.sentinelContentHash).toBeTruthy();
    }
    // cleanupStatus is always present: "cleaned" | "skipped" | "failed".
    // With writeBank="default", cleanup is skipped (default is never cleaned).
    expect(["cleaned", "skipped", "failed"]).toContain(receipt.cleanupStatus);
  });

  test("bank list returns at minimum the 'default' bank", async () => {
    const banks = await tribunusMemoryBankList();
    expect(Array.isArray(banks)).toBe(true);
    expect(banks.length).toBeGreaterThanOrEqual(1);
    expect(banks).toContain("default");
  });
});

// ============================================================================
// DOMAIN 3: Memory Receipt Completeness
//     Every receipt proves what bank, path, and outcome.
//     Success receipts carry operation-specific payload.
//     Failure receipts carry an error string.
// ============================================================================

describe("Memory Receipt Completeness", () => {
  test("recall receipt has all required fields", async () => {
    const receipt = await tribunusMemoryRecall("default", "completeness check");
    // Base receipt fields
    expect(receipt).toHaveProperty("success");
    expect(typeof receipt.success).toBe("boolean");
    expect(receipt.operation).toBe("recall");
    expect(receipt.logicalBank).toBeTruthy();
    expect(receipt.physicalDataDir).toBeTruthy();
    expect(receipt.physicalDbPath).toBeTruthy();
    expect(receipt.timestamp).toBeTruthy();
    // RecallReceipt-specific fields
    expect(receipt).toHaveProperty("query");
    expect(typeof receipt.query).toBe("string");
    expect(receipt).toHaveProperty("results");
    expect(Array.isArray(receipt.results)).toBe(true);
  });

  test("remember receipt has memoryId when successful", async () => {
    const receipt = await tribunusMemoryRemember("default", "test content for receipt completeness");
    expect(receipt.operation).toBe("remember");
    expect(receipt.logicalBank).toBe("default");
    if (receipt.success) {
      expect(receipt.memoryId).toBeTruthy();
      expect(typeof receipt.memoryId).toBe("string");
      expect(receipt.error).toBeUndefined();
    } else {
      // If mnemopi CLI is unavailable, the operation fails but the
      // receipt still has all base fields
      expect(receipt.error).toBeTruthy();
    }
  });

  test("failed operation has error field set", async () => {
    const receipt = await tribunusMemoryRecall("bank-that-does-not-exist-for-sure-xyz", "test");
    expect(receipt.success).toBe(false);
    expect(receipt.error).toBeTruthy();
    expect(typeof receipt.error).toBe("string");
    expect((receipt.error || "").length).toBeGreaterThan(0);
  });
});
