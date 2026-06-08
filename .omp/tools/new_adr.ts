import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { spawnSync } from "node:child_process";

function artifactLog(
  pi: { cwd: string },
  ctx: { sessionId: string },
  event: Record<string, unknown>
): void {
  try {
    const sessionId = ctx.sessionId || "unknown";
    const dir = resolve(pi.cwd, `docs/json/omp/sessions/${sessionId}/artifacts`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(
      resolve(dir, `${sessionId}.v1.jsonl`),
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n",
      "utf8"
    );
  } catch {
    // Silently fail - analytics are non-critical
  }
}

function analytics(
  pi: { cwd: string },
  ctx: { sessionId: string },
  tool: string,
  extra: Record<string, unknown>
): void {
  try {
    const sessionId = ctx.sessionId || "unknown";
    const dir = resolve(pi.cwd, `docs/json/omp/sessions/${sessionId}/analytics`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(
      resolve(dir, "new_adr_usage.v1.jsonl"),
      JSON.stringify({
        at: new Date().toISOString(),
        tool,
        ...extra,
      }) + "\n",
      "utf8"
    );
  } catch {
    // Silently fail
  }
}

function findNextAdrId(worktree: string): string {
  const adrDir = resolve(worktree, "docs/adr");
  if (!existsSync(adrDir)) return "0001";

  const files = readdirSync(adrDir);
  const numbers = files
    .map((f) => {
      const match = f.match(/^(\d{4})-/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((n) => n > 0);

  if (numbers.length === 0) return "0001";
  const max = Math.max(...numbers);
  return `${max + 1}`.padStart(4, "0");
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const factory: CustomToolFactory = (pi) => ({
  name: "new_adr",
  label: "New ADR",
  description:
    "Create a new Architecture Decision Record (ADR) following the Tribunus standardized format. Generates a sequential ID and writes to docs/adr/NNNN-slug.v1.json.",

  parameters: pi.zod.object({
    title: pi.zod.string().describe("ADR title (e.g., 'Use Effect v4 for Side Effects')"),
    description: pi.zod.string().describe("ADR description and context"),
    status: pi.zod
      .enum(["proposed", "accepted", "deprecated", "superseded"])
      .default("proposed")
      .describe("ADR status"),
    authors: pi.zod
      .array(pi.zod.string())
      .default([])
      .describe("List of author identifiers"),
    tags: pi.zod
      .array(pi.zod.string())
      .default([])
      .describe("List of tags"),
    research_packet_id: pi.zod.string().optional().describe(
      "Research packet ID to link and pre-populate context from"
    ),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("new_adr cancelled");

    const sessionId = ctx.sessionId || "unknown";
    const adrId = findNextAdrId(pi.cwd);
    const slug = slugify(params.title);
    const fileName = `${adrId}-${slug}.v1.json`;
    const filePath = resolve(pi.cwd, "docs/adr", fileName);

    // If research_packet_id provided, read the packet and pre-populate context
    let description = params.description;
    if (params.research_packet_id) {
      const packetPath = resolve(pi.cwd, "docs/json/omp/research", `${params.research_packet_id}.v1.json`);
      if (existsSync(packetPath)) {
        try {
          const packet = JSON.parse(readFileSync(packetPath, "utf8"));
          if (packet.type === "research_context_packet" && Array.isArray(packet.research_findings)) {
            const findings = packet.research_findings as Array<{ category: string; title: string; finding: string; confidence: string }>;
            const findingSummary = findings
              .filter((f) => f.confidence === "high")
              .map((f) => `[${f.category}] ${f.title}: ${f.finding.slice(0, 200)}`)
              .join("\n\n");
            if (!description) {
              description = `Research-backed ADR. Topic: ${packet.research_topic}\n\nKey findings:\n${findingSummary}`;
            }
            onUpdate?.({
              status: "creating",
              adrId,
              fileName,
              filePath: `docs/adr/${fileName}`,
              research_packet_id: params.research_packet_id,
              findings_linked: findings.length,
            });
          }
        } catch {}
      }
    }

    onUpdate?.({
      status: "creating",
      adrId,
      fileName,
      filePath: `docs/adr/${fileName}`,
    });

    const now = new Date().toISOString();
    const newAdr = {
      schema: "rig.relay.adr.v1",
      schema_version: "v1",
      id: adrId,
      title: params.title,
      status: params.status,
      date: now.slice(0, 10),
      last_modified: now,
      context: description,
      decision: "",
      consequences: "",
      authors: params.authors,
      tags: params.tags,
    };

    try {
      mkdirSync(resolve(pi.cwd, "docs/adr"), { recursive: true });
      writeFileSync(filePath, JSON.stringify(newAdr, null, 2), "utf8");
    } catch (error) {
      throw new Error(`Failed to write ADR: ${error}`);
    }

    const sizeBytes = Buffer.byteLength(JSON.stringify(newAdr), "utf8");

    artifactLog(pi, ctx, {
      action: "new_adr",
      adrId,
      fileName,
      filePath,
      sizeBytes,
      sessionId,
    });

    analytics(pi, ctx, "new_adr", {
      adrId,
      fileName,
      status: "success",
    });

    onUpdate?.({
      status: "created",
      adrId,
      fileName,
      filePath: `docs/adr/${fileName}`,
      contentPreview: JSON.stringify(newAdr, null, 2).slice(0, 500),
    });

    return {
      adrId,
      fileName,
      filePath: `docs/adr/${fileName}`,
      status: "created",
      message: `New ADR ${adrId} created at docs/adr/${fileName}`,
      sizeBytes,
    };
  },
});

export default factory;
