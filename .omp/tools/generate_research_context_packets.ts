import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const factory: CustomToolFactory = (pi) => ({
  name: "generate_research_context_packets",
  label: "Generate Research Context Packets",
  description:
    "Generate a structured research context packet from deep online research, archiving findings as a versioned JSON artifact in docs/json/omp/research/ with bidirectional entity links. The packet persists research results so they can be cross-referenced by ADRs, campaigns, missions, lanes, and tasks — preventing research loss across sessions. Also generates full implementation specs with pattern examples suitable for populating campaigns, missions, lanes, and tasks. Call this after completing deep online research on a topic. Provide the transcript summary, research findings with sources, and optional implementation specs and entity links. The tool writes the packet and creates MemoryLink entries for every linked entity so the research surfaces in context when working on those entities.",

  parameters: pi.zod.object({
    transcript_summary: pi.zod.string().describe(
      "Summary of the conversation transcript that motivated this research — key decisions, open questions, and context that drove the research direction"
    ),
    research_topic: pi.zod.string().describe(
      "The primary research question or topic investigated"
    ),
    research_findings: pi.zod.array(
      pi.zod.object({
        category: pi.zod.enum([
          "architecture",
          "protocol",
          "pattern",
          "risk",
          "dependency",
          "comparison",
          "validation",
        ]).describe("Finding category"),
        title: pi.zod.string().describe("Concise finding title"),
        finding: pi.zod.string().describe("Detailed finding with analysis"),
        confidence: pi.zod.enum(["high", "medium", "low"]).describe(
          "Confidence level based on source quality and corroboration"
        ),
        sources: pi.zod.array(
          pi.zod.object({
            url: pi.zod.string().describe("Source URL"),
            title: pi.zod.string().describe("Source title"),
            relevance: pi.zod.string().describe("Why this source is relevant"),
            key_excerpts: pi.zod.array(pi.zod.string()).describe("Key excerpts or quotes"),
          })
        ).describe("Sources supporting this finding"),
        related_concepts: pi.zod.array(pi.zod.string()).describe(
          "Related architectural concepts, patterns, or systems"
        ),
      })
    ).describe("Structured research findings with sources and confidence levels"),

    implementation_specs: pi.zod.array(
      pi.zod.object({
        title: pi.zod.string().describe("Spec title"),
        description: pi.zod.string().describe(
          "What this spec covers — the problem, approach, and expected outcome"
        ),
        acceptance_criteria: pi.zod.array(pi.zod.string()).describe(
          "Verifiable criteria that define when this spec is satisfied"
        ),
        implementation_patterns: pi.zod.array(
          pi.zod.object({
            name: pi.zod.string().describe("Pattern name"),
            description: pi.zod.string().describe(
              "What the pattern solves and when to use it"
            ),
            code_example: pi.zod.string().optional().describe(
              "Illustrative code example (language-agnostic or concrete)"
            ),
            references: pi.zod.array(pi.zod.string()).describe(
              "Source URLs or internal references"
            ),
          })
        ).describe("Known patterns, conventions, and examples"),
        suggested_campaign: pi.zod.object({
          title: pi.zod.string().describe("Suggested campaign name"),
          objective: pi.zod.string().describe("Campaign objective"),
        }).optional().describe("Optional suggested campaign to contain this work"),
        suggested_missions: pi.zod.array(
          pi.zod.object({
            title: pi.zod.string().describe("Mission name"),
            purpose: pi.zod.string().describe("What this mission achieves and why"),
            acceptance_criteria: pi.zod.array(pi.zod.string()).describe(
              "Verifiable acceptance criteria"
            ),
            priority: pi.zod.number().describe("Priority 0-100, higher = more urgent"),
            suggested_lanes: pi.zod.array(
              pi.zod.object({
                title: pi.zod.string().describe("Lane name"),
                scope: pi.zod.string().describe("Scope identifier for single-writer rule"),
                description: pi.zod.string().describe("Lane description and boundaries"),
                write_paths: pi.zod.array(pi.zod.string()).describe(
                  "Filesystem paths this lane can write to"
                ),
                suggested_tasks: pi.zod.array(
                  pi.zod.object({
                    title: pi.zod.string().describe("Task title (5-10 words)"),
                    description: pi.zod.string().describe(
                      "Task description with concrete deliverable"
                    ),
                    estimated_effort: pi.zod.string().describe(
                      "Estimated effort e.g. '2 days', '4 hours'"
                    ),
                    priority: pi.zod.number().describe(
                      "Priority 0-100, higher = more urgent"
                    ),
                    depends_on: pi.zod.array(pi.zod.string()).describe(
                      "Task titles this task depends on"
                    ),
                  })
                ).describe("Tasks decomposing this lane into concrete work units"),
              })
            ).describe("Lanes decomposing this mission into single-writer scopes"),
          })
        ).describe("Suggested mission decomposition with lanes and tasks"),
      })
    ).optional().default([]).describe(
      "Implementation specifications with pattern examples, ready to populate campaigns, missions, lanes, and tasks"
    ),

    linked_entities: pi.zod.array(
      pi.zod.object({
        entity_type: pi.zod.enum(["adr", "campaign", "mission", "lane", "task"]).describe(
          "Type of entity this research informs"
        ),
        entity_id: pi.zod.string().describe(
          "Entity ID (e.g. campaign slug like '0001-data-architecture')"
        ),
        relationship: pi.zod.enum([
          "context",
          "decision",
          "lesson",
          "constraint",
          "requirement",
        ]).describe("How this research relates to the entity"),
      })
    ).optional().default([]).describe(
      "Entities this research packet should be linked to for cross-referencing"
    ),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("generate_research_context_packets cancelled");

    const researchDir = resolve(pi.cwd, "docs", "json", "omp", "research");
    const linksDir = resolve(researchDir, "memory-links");
    const packetId = generateId("rcp");
    const packetPath = resolve(researchDir, `${packetId}.v1.json`);
    const now = new Date().toISOString();

    onUpdate?.({
      status: "creating",
      packet_id: packetId,
      research_topic: params.research_topic,
    });

    // Ensure directories exist
    if (!existsSync(researchDir)) mkdirSync(researchDir, { recursive: true });

    const packet = {
      schema: "rig.relay.research-context-packet.v1",
      schema_version: "v1",
      id: packetId,
      type: "research_context_packet",
      research_topic: params.research_topic,
      transcript_summary: params.transcript_summary,
      research_findings: params.research_findings,
      implementation_specs: params.implementation_specs,
      linked_entities: params.linked_entities,
      session_id: ctx.sessionId || "unknown",
      created_at: now,
    };

    try {
      writeFileSync(packetPath, JSON.stringify(packet, null, 2), "utf8");
    } catch (error) {
      throw new Error(`Failed to write research packet: ${error}`);
    }

    // Create MemoryLink entries for each linked entity
    const memoryLinks: Array<Record<string, unknown>> = [];
    if (params.linked_entities.length > 0) {
      if (!existsSync(linksDir)) mkdirSync(linksDir, { recursive: true });

      for (const link of params.linked_entities) {
        const linkId = generateId("ml");
        const memoryLink = {
          schema: "rig.relay.memory-link.v1",
          schema_version: "v1",
          id: linkId,
          type: "memory_link",
          entity_type: link.entity_type,
          entity_id: link.entity_id,
          memory_bank: "tribunus-core",
          memory_id: packetId,
          relationship: link.relationship,
          relevance_score: 1.0,
          notes: `Research context packet: ${params.research_topic}`,
          session_id: ctx.sessionId || "unknown",
          created_at: now,
        };

        const linkPath = resolve(linksDir, `${linkId}.v1.json`);
        writeFileSync(linkPath, JSON.stringify(memoryLink, null, 2), "utf8");
        memoryLinks.push(memoryLink);
      }
    }

    const findingCount = params.research_findings.length;
    const specCount = params.implementation_specs.length;
    const linkCount = params.linked_entities.length;
    const categories = [...new Set(params.research_findings.map((f) => f.category))];
    const highConfidence = params.research_findings.filter(
      (f) => f.confidence === "high"
    ).length;

    const sizeBytes = Buffer.byteLength(JSON.stringify(packet), "utf8");

    onUpdate?.({
      status: "created",
      packet_id: packetId,
      findings: findingCount,
      specs: specCount,
      links: linkCount,
      memory_links: memoryLinks.length,
    });

    return {
      content: [
        {
          type: "text",
          text: [
            `Research packet created: ${packetId}`,
            `Path: docs/json/omp/research/${packetId}.v1.json`,
            `Topic: ${params.research_topic}`,
            ``,
            `${findingCount} findings across [${categories.join(", ")}] categories`,
            `  ${highConfidence} high confidence`,
            `${specCount} implementation specs`,
            `${linkCount} entity links → ${memoryLinks.length} memory links created`,
            ``,
            `Linked entities:`,
            ...params.linked_entities.map(
              (l) => `  ${l.entity_type}:${l.entity_id} (${l.relationship})`
            ),
            ``,
            `Implementation spec titles:`,
            ...params.implementation_specs.map((s) => `  ${s.title}`),
            ``,
            `Use this packet's implementation specs to populate campaigns, missions, lanes, and tasks via the new_campaign/new_mission/new_lane/new_task tools.`,
            `Research findings will surface automatically when working on linked entities.`,
          ].join("\n"),
        },
      ],
      details: {
        status: "created",
        packet_id: packetId,
        packet_path: `docs/json/omp/research/${packetId}.v1.json`,
        findings_count: findingCount,
        finding_categories: categories,
        high_confidence_findings: highConfidence,
        implementation_specs_count: specCount,
        linked_entities_count: linkCount,
        memory_links_created: memoryLinks.length,
        linked_entity_ids: params.linked_entities.map((l) => ({
          type: l.entity_type,
          id: l.entity_id,
          relationship: l.relationship,
        })),
        implementation_spec_titles: params.implementation_specs.map((s) => s.title),
        size_bytes: sizeBytes,
      },
    };
  },
});

export default factory;
