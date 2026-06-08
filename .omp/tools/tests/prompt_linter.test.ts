import { describe, it, expect } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

const ROLES_DIR = resolve(import.meta.dir, "../../prompts/roles")
const WORKFLOWS_DIR = resolve(import.meta.dir, "../../prompts/workflows")
const SNIPPETS_DIR = resolve(import.meta.dir, "../../prompts/snippets")
const CONSTITUTION_PATH = resolve(import.meta.dir, "../../../AGENTS.md")

function readPromptFile(dir: string, file: string): string {
  const filepath = resolve(dir, file)
  if (!existsSync(filepath)) {
    throw new Error(`Prompt file does not exist: ${filepath}`)
  }
  return readFileSync(filepath, "utf8")
}

describe("OMP Prompt Suite Linter", () => {

  describe("AGENTS.md Constitution", () => {
    it("contains the core OMP constitutional constraints", () => {
      const content = readFileSync(CONSTITUTION_PATH, "utf8")
      expect(content).toContain("OMP Runtime Constitution")
      expect(content).toContain("PGlite database is the single source of truth")
      expect(content).toContain("derived analytical queries")
      expect(content).toContain("receipts")
      expect(content).toContain("transport")
    })

    it("requires code-intelligence-first context acquisition sequence", () => {
      const content = readFileSync(CONSTITUTION_PATH, "utf8")
      expect(content).toContain("Check Code-Index Snapshot")
      expect(content).toContain("Query Kernel First")
      expect(content).toContain("semantic_repo_map")
      expect(content).toContain("impact_analysis")
    })
  })

  describe("Role Prompts Validation", () => {
    const roles = ["implementer.md", "reviewer.md", "planner.md", "verifier.md", "exporter.md", "recovery.md"]

    it("ensures all roles require code-intelligence context lookup first", () => {
      for (const role of roles) {
        const content = readPromptFile(ROLES_DIR, role)
        const hasKernelLookup = content.toLowerCase().includes("code-intelligence") || content.toLowerCase().includes("kernel")
        expect(hasKernelLookup).toBe(true)
      }
    })

    it("ensures read-only roles explicitly prohibit mutation", () => {
      const readOnlyRoles = ["reviewer.md", "verifier.md", "exporter.md", "recovery.md"]
      for (const role of readOnlyRoles) {
        const content = readPromptFile(ROLES_DIR, role)
        const prohibitsMutation = content.toLowerCase().includes("prohibit") ||
                                  content.toLowerCase().includes("non-mutating") ||
                                  content.toLowerCase().includes("read-only") ||
                                  content.toLowerCase().includes("no auto-repair")
        expect(prohibitsMutation).toBe(true)
      }
    })

    it("ensures mutation roles require OMP write tools with locks, hashes, and receipts", () => {
      const content = readPromptFile(ROLES_DIR, "implementer.md")
      expect(content).toContain("text_replace")
      expect(content).toContain("batch_edit")
      expect(content).toContain("locks")
      expect(content).toContain("hash")
      expect(content).toContain("receipt")
    })

    it("ensures planner is restricted to drafts and campaign tools", () => {
      const content = readPromptFile(ROLES_DIR, "planner.md")
      expect(content).toContain("draft")
      expect(content).toContain("campaign")
    })

    it("ensures recovery role is forbidden from auto-repairing without explicit mission", () => {
      const content = readPromptFile(ROLES_DIR, "recovery.md")
      expect(content).toContain("No Auto-Repair")
      expect(content).toContain("repair mission")
    })
  })

  describe("Workflow Prompts Validation", () => {
    it("ensures unattended workflow includes stop conditions", () => {
      const content = readPromptFile(WORKFLOWS_DIR, "unattended_mission.md")
      expect(content).toContain("Stopping Gates")
    })

    it("ensures campaign completion requires consistency validation", () => {
      const content = readPromptFile(WORKFLOWS_DIR, "campaign_completion.md")
      expect(content).toContain("snapshot")
      expect(content).toContain("consistent")
    })

    it("ensures review packet triage inspects 10_review_findings.json directly", () => {
      const content = readPromptFile(WORKFLOWS_DIR, "review_packet_triage.md")
      expect(content).toContain("10_review_findings.json")
      expect(content).toContain("severity")
    })
  })
})

