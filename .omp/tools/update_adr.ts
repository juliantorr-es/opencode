import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

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
    // Silently fail
  }
}

function findAdrFile(worktree: string, adrId: string): string | null {
  const adrDir = resolve(worktree, "docs/adr");
  if (!existsSync(adrDir)) return null;
  const files = readdirSync(adrDir);
  const match = files.find((f) => f.startsWith(`${adrId}-`) && f.endsWith(".v1.json"));
  return match ? resolve(adrDir, match) : null;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const factory: CustomToolFactory = (pi) => ({
  name: "update_adr",
  label: "Update ADR",
  description:
    "Update an existing Architecture Decision Record. Accepts an ADR ID to locate the file, optional field overrides (title, status, decision, consequences, tags), and an optional research_packet_id to auto-populate decision and consequences from deep research findings. Also creates a memory link between the ADR and the research packet for cross-referencing.",

  parameters: pi.zod.object({
    adr_id: pi.zod.string().describe(
      "ADR ID to update (e.g., '0011' — the 4-digit prefix of the ADR filename)"
    ),
    title: pi.zod.string().optional().describe("New ADR title"),
    status: pi.zod
      .enum(["proposed", "accepted", "deprecated", "superseded"])
      .optional()
      .describe("New ADR status"),
    decision: pi.zod.string().optional().describe(
      "The decision made — what was chosen and why"
    ),
    consequences: pi.zod.string().optional().describe(
      "Consequences — what becomes easier, harder, or different as a result"
    ),
    tags: pi.zod.array(pi.zod.string()).optional().describe("Replacement tag list"),
    research_packet_id: pi.zod.string().optional().describe(
      "Research packet ID to populate decision/consequences from and link to this ADR"
    ),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("update_adr cancelled");

    const sessionId = ctx.sessionId || "unknown";
    const adrPath = findAdrFile(pi.cwd, params.adr_id);

    if (!adrPath) {
      return {
        content: [{ type: "text", text: `ADR '${params.adr_id}' not found in docs/adr/` }],
        details: { status: "fail", error: "ADR not found" },
      };
    }

    let existing: Record<string, unknown>;
    try {
      existing = JSON.parse(readFileSync(adrPath, "utf8"));
    } catch {
      return {
        content: [{ type: "text", text: `Failed to parse ADR at ${adrPath}` }],
        details: { status: "fail", error: "Parse error" },
      };
    }

    const now = new Date().toISOString();
    const changes: string[] = [];
    let researchPopulated = false;

    // Apply explicit overrides
    if (params.title !== undefined) {
      existing.title = params.title;
      changes.push("title");
    }
    if (params.status !== undefined) {
      existing.status = params.status;
      changes.push("status");
    }
    if (params.decision !== undefined) {
      existing.decision = params.decision;
      changes.push("decision");
    }
    if (params.consequences !== undefined) {
      existing.consequences = params.consequences;
      changes.push("consequences");
    }
    if (params.tags !== undefined) {
      existing.tags = params.tags;
      changes.push("tags");
    }

    // If research_packet_id provided, populate decision/consequences from findings
    if (params.research_packet_id) {
      const packetPath = resolve(
        pi.cwd,
        "docs/json/omp/research",
        `${params.research_packet_id}.v1.json`
      );
      if (existsSync(packetPath)) {
        try {
          const packet = JSON.parse(readFileSync(packetPath, "utf8"));
          if (packet.type === "research_context_packet" && Array.isArray(packet.research_findings)) {
            const findings = packet.research_findings as Array<{
              category: string;
              title: string;
              finding: string;
              confidence: string;
            }>;

            const highFindings = findings.filter((f) => f.confidence === "high");
            const allFindings = [...highFindings, ...findings.filter((f) => f.confidence !== "high")];

            // Build decision from architecture/pattern/protocol findings
            if (!params.decision) {
              const decisionRelevant = allFindings.filter((f) =>
                ["architecture", "protocol", "pattern"].includes(f.category)
              );
              if (decisionRelevant.length > 0) {
                existing.decision = decisionRelevant
                  .map(
                    (f) =>
                      `### ${f.title}\n${f.finding}\n\nConfidence: ${f.confidence}`
                  )
                  .join("\n\n");
                changes.push("decision (from research)");
              }
            }

            // Build consequences from risk/dependency findings
            if (!params.consequences) {
              const consequenceRelevant = allFindings.filter((f) =>
                ["risk", "dependency", "comparison"].includes(f.category)
              );
              if (consequenceRelevant.length > 0) {
                existing.consequences = consequenceRelevant
                  .map(
                    (f) =>
                      `### ${f.title}\n${f.finding}\n\nConfidence: ${f.confidence}`
                  )
                  .join("\n\n");
                changes.push("consequences (from research)");
              }
            }

            // Also update context if it was empty
            if (!existing.context) {
              const contextFindings = allFindings.filter((f) =>
                ["validation", "architecture", "protocol"].includes(f.category)
              );
              if (contextFindings.length > 0) {
                existing.context = `Research-backed ADR. Topic: ${packet.research_topic}\n\nKey findings:\n${
                  contextFindings
                    .slice(0, 5)
                    .map((f) => `[${f.category}] ${f.title}: ${f.finding.slice(0, 200)}`)
                    .join("\n\n")
                }`;
                changes.push("context (from research)");
              }
            }

            researchPopulated = true;
          }
        } catch {
          // Packet parse failed — continue with explicit overrides only
        }

        // Create memory link
        const linksDir = resolve(pi.cwd, "docs/json/omp/research", "memory-links");
        if (!existsSync(linksDir)) mkdirSync(linksDir, { recursive: true });
        const linkId = generateId("ml");
        const memoryLink = {
          schema: "rig.relay.memory-link.v1",
          schema_version: "v1",
          id: linkId,
          type: "memory_link",
          entity_type: "adr",
          entity_id: params.adr_id,
          memory_bank: "tribunus-core",
          memory_id: params.research_packet_id,
          relationship: "decision",
          relevance_score: 1.0,
          notes: `ADR updated with research findings`,
          session_id: sessionId,
          created_at: now,
        };
        writeFileSync(
          resolve(linksDir, `${linkId}.v1.json`),
          JSON.stringify(memoryLink, null, 2),
          "utf8"
        );
      }
    }

    existing.last_modified = now;

    try {
      writeFileSync(adrPath, JSON.stringify(existing, null, 2), "utf8");
    } catch (error) {
      throw new Error(`Failed to write ADR: ${error}`);
    }

    const sizeBytes = Buffer.byteLength(JSON.stringify(existing), "utf8");

    artifactLog(pi, ctx, {
      action: "update_adr",
      adrId: params.adr_id,
      adrPath,
      changes,
      researchPopulated,
      sizeBytes,
      sessionId,
    });

    const changeList = changes.length > 0 ? `\nChanges: ${changes.join(", ")}` : "\nNo changes applied.";

    return {
      content: [
        {
          type: "text",
          text: `ADR ${params.adr_id} updated at ${adrPath}${changeList}${researchPopulated ? `\nLinked to research packet: ${params.research_packet_id}` : ""}`,
        },
      ],
      details: {
        adrId: params.adr_id,
        status: "updated",
        adrPath,
        changes,
        researchPopulated,
        researchPacketId: params.research_packet_id || null,
        sizeBytes,
      },
    };
  },
});

export default factory;
