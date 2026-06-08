#!/usr/bin/env bun
/**
 * Tribunus Memory Session Start Ritual
 * Layer 5: Session-start recall ritual for Oh My Pi
 * Uses the new tribunus_memory bank-scoped tools
 * 
 * Usage:
 *   bun run scripts/mnemopi-session-start.ts --bank tribunus-core --mission "implement extension SDK" --repo . --branch dev --gate authority-manifests
 */

import { tribunusMemoryRecall } from "./tribunus_memory";
import { $ } from "bun";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

interface SessionStartOptions {
  bank: string;
  mission: string;
  repo: string;
  branch: string;
  gate: string;
}

interface RecallResult {
  query: string;
  results: Array<{
    id: string;
    content: string;
    score: number;
    bank?: string;
  }>;
}

interface ContextPacket {
  session: SessionStartOptions;
  timestamp: string;
  recalls: RecallResult[];
  summary: string;
}

const DEFAULT_BANK = "tribunus-core";

function parseArgs(): SessionStartOptions {
  const args = Bun.argv.slice(2);
  const options: Partial<SessionStartOptions> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--bank" || arg === "-b") options.bank = args[++i];
    else if (arg === "--mission" || arg === "-m") options.mission = args[++i];
    else if (arg === "--repo" || arg === "-r") options.repo = args[++i];
    else if (arg === "--branch" || arg === "-br") options.branch = args[++i];
    else if (arg === "--gate" || arg === "-g") options.gate = args[++i];
  }

  return {
    bank: options.bank ?? DEFAULT_BANK,
    mission: options.mission ?? "unknown",
    repo: options.repo ?? process.cwd,
    branch: options.branch ?? getCurrentBranch(),
    gate: options.gate ?? "unknown",
  };
}

function getCurrentBranch(): string {
  try {
    return $`git branch --show-current`.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function buildQuery(mission: string, bank: string, queryType: string): string {
  const baseQueries = {
    mission: mission,
    architecture: `Tribunus ${bank.replace("tribunus-", "")} architecture`,
    "recent-failure": `${bank} failure debug error`,
    "acceptance-gate": `${mission} acceptance criteria gate`,
  };
  return baseQueries[queryType as keyof typeof baseQueries] || mission;
}

function formatRecallResult(receipt: any): RecallResult {
  return {
    query: receipt.query,
    results: receipt.results.map((r: any) => ({
      id: r.id,
      content: r.content,
      score: r.score,
      bank: receipt.logicalBank,
    })),
  };
}

function buildContextPacket(session: SessionStartOptions, recalls: RecallResult[]): ContextPacket {
  return {
    session,
    timestamp: new Date().toISOString(),
    recalls,
    summary: `Session started: ${session.mission} on ${session.branch} at ${session.repo}. ${recalls.length} recall queries executed.`,
  };
}

function formatContextPacket(packet: ContextPacket): string {
  const lines: string[] = [
    "=".repeat(70),
    "TRIBUNUS MEMORY SESSION START",
    "=".repeat(70),
    "",
    `Bank: ${packet.session.bank}`,
    `Mission: ${packet.session.mission}`,
    `Repository: ${packet.session.repo}`,
    `Branch: ${packet.session.branch}`,
    `Gate: ${packet.session.gate}`,
    `Timestamp: ${packet.timestamp}`,
    "",
    "=".repeat(70),
    "RECALLED CONTEXT",
    "=".repeat(70),
  ];

  for (const recall of packet.recalls) {
    lines.push(`\n[Query: ${recall.query}]`);
    lines.push("-".repeat(70));

    if (recall.results.length === 0) {
      lines.push("  (no results)");
    } else {
      for (const result of recall.results) {
        lines.push(`  [${result.score?.toFixed(3)}] ${result.id} (${result.bank})`);
        lines.push(`    ${result.content}`);
        lines.push("");
      }
    }
  }

  lines.push("");
  lines.push("=".repeat(70));
  lines.push("SESSION CONTEXT READY");
  lines.push("=".repeat(70));
  lines.push("");
  lines.push(`Summary: ${packet.summary}`);
  lines.push("");
  lines.push("Treat recalled memory as PRIOR CONTEXT, not proof.");
  lines.push("Proof comes from files, tests, durable state, and user constraints.");
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const session = parseArgs();

  console.log(`Starting Tribunus session: ${session.mission}`);
  console.log(`Bank: ${session.bank}, Branch: ${session.branch}, Gate: ${session.gate}`);

  // Layer 5: Execute 4 query shapes
  const queryTypes = ["mission", "architecture", "recent-failure", "acceptance-gate"];
  const recalls: RecallResult[] = [];

  for (const queryType of queryTypes) {
    const query = buildQuery(session.mission, session.bank, queryType);
    console.log(`\nExecuting recall: [${queryType}] ${query}`);
    const receipt = await tribunusMemoryRecall(session.bank, query, 5);
    recalls.push(formatRecallResult(receipt));
    console.log(`  Found ${receipt.results.length} results`);
  }

  // Build and format context packet
  const packet = buildContextPacket(session, recalls);
  console.log(formatContextPacket(packet));

  // Write context packet to file for agent consumption
  const outputPath = resolve(process.cwd(), ".mnemopi-session-context.json");
  await Bun.write(outputPath, JSON.stringify(packet, null, 2));
  console.log(`Context packet written to: ${outputPath}`);
}

main();
