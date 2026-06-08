import { describe, it, expect } from "bun:test"
import { structReadManifest, textReplaceManifest, batchEditManifest } from "../_lib/manifest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { OmpToolManifestV1 } from "../_lib/types"

const MANIFESTS_DIR = resolve(import.meta.dir, "../manifests")

// ── Builder functions ──

describe("structReadManifest", () => {
  const manifest = structReadManifest()

  it("returns valid OmpToolManifestV1 with schema field", () => {
    expect(manifest).toBeDefined()
    expect(typeof manifest).toBe("object")
  })

  it("has correct schema", () => {
    expect(manifest.schema).toBe("omp.tool.manifest.v1")
  })

  it("has correct tool_id", () => {
    expect(manifest.tool_id).toBe("struct_read")
  })

  it("has version string", () => {
    expect(typeof manifest.version).toBe("string")
    expect(manifest.version.length).toBeGreaterThan(0)
  })

  it("has authority profile with risk_level read", () => {
    expect(manifest.authority).toBeDefined()
    expect(manifest.authority.risk_level).toBe("read")
  })

  it("has read-side authority (no approval, no hash precondition)", () => {
    expect(manifest.authority.side_effects).toBe("filesystem_read")
    expect(manifest.authority.requires_approval).toBe(false)
    expect(manifest.authority.requires_hash_precondition).toBe(false)
  })

  it("has input_schema requiring path", () => {
    const schema = manifest.input_schema as Record<string, unknown>
    expect(schema).toBeDefined()
    expect((schema as { required?: string[] }).required).toContain("path")
  })

  it("has provider_exports for all providers", () => {
    const pe = manifest.provider_exports
    expect(pe.mistral_function_calling).toBe(true)
    expect(pe.openai_tools).toBe(true)
    expect(pe.anthropic_tools).toBe(true)
    expect(pe.mcp).toBe(true)
  })
})

describe("textReplaceManifest", () => {
  const manifest = textReplaceManifest()

  it("returns valid manifest", () => {
    expect(manifest).toBeDefined()
    expect(manifest.schema).toBe("omp.tool.manifest.v1")
  })

  it("has risk_level write_medium", () => {
    // Spec section 4: text_replace is write_medium. The manifest builder returns this.
    // The canonical JSON manifest also declares write_medium.
    expect(manifest.authority.risk_level).toBe("write_medium")
  })

  it("has requires_hash_precondition true", () => {
    expect(manifest.authority.requires_hash_precondition).toBe(true)
  })

  it("has requires_approval true", () => {
    expect(manifest.authority.requires_approval).toBe(true)
  })

  it("has side_effects filesystem_write", () => {
    expect(manifest.authority.side_effects).toBe("filesystem_write")
  })

  it("has correct tool_id", () => {
    expect(manifest.tool_id).toBe("text_replace")
  })

  it("has input_schema requiring path, expected_before_sha256, old_text, new_text", () => {
    const schema = manifest.input_schema as Record<string, unknown>
    const required = (schema as { required?: string[] }).required ?? []
    expect(required).toContain("path")
    expect(required).toContain("expected_before_sha256")
    expect(required).toContain("old_text")
    expect(required).toContain("new_text")
  })
})

describe("batchEditManifest", () => {
  const manifest = batchEditManifest()

  it("returns valid manifest", () => {
    expect(manifest).toBeDefined()
    expect(manifest.schema).toBe("omp.tool.manifest.v1")
  })

  it("has risk_level write_high", () => {
    expect(manifest.authority.risk_level).toBe("write_high")
  })

  it("has requires_approval true", () => {
    expect(manifest.authority.requires_approval).toBe(true)
  })

  it("has requires_hash_precondition true", () => {
    expect(manifest.authority.requires_hash_precondition).toBe(true)
  })

  it("has side_effects filesystem_write", () => {
    expect(manifest.authority.side_effects).toBe("filesystem_write")
  })

  it("has correct tool_id", () => {
    expect(manifest.tool_id).toBe("batch_edit")
  })

  it("has input_schema requiring files", () => {
    const schema = manifest.input_schema as Record<string, unknown>
    const required = (schema as { required?: string[] }).required ?? []
    expect(required).toContain("files")
  })
})

// ── Manifest JSON files ──

describe("Manifest JSON files", () => {
  const manifestFiles = [
    { name: "struct_read.v1.json", toolId: "struct_read" },
    { name: "text_replace.v1.json", toolId: "text_replace" },
    { name: "batch_edit.v1.json", toolId: "batch_edit" },
  ] as const

  for (const { name, toolId } of manifestFiles) {
    describe(name, () => {
      let json: Record<string, unknown>

      it("is valid JSON", () => {
        const raw = readFileSync(resolve(MANIFESTS_DIR, name), "utf-8")
        expect(() => {
          json = JSON.parse(raw)
        }).not.toThrow()
        json = JSON.parse(raw)
      })

      it("has correct schema field", () => {
        expect(json.schema).toBe("omp.tool.manifest.v1")
      })

      it(`has tool_id "${toolId}"`, () => {
        expect(json.tool_id).toBe(toolId)
      })

      it("has authority profile", () => {
        expect(json.authority).toBeDefined()
        expect(typeof json.authority).toBe("object")
        const auth = json.authority as Record<string, unknown>
        expect(typeof auth.risk_level).toBe("string")
        expect(typeof auth.side_effects).toBe("string")
        expect(typeof auth.requires_approval).toBe("boolean")
        expect(typeof auth.requires_hash_precondition).toBe("boolean")
      })

      it("has input_schema", () => {
        expect(json.input_schema).toBeDefined()
        const schema = json.input_schema as Record<string, unknown>
        expect(schema.type).toBe("object")
      })

      it("has provider_exports for all providers", () => {
        const pe = json.provider_exports as Record<string, unknown>
        expect(pe.mistral_function_calling).toBe(true)
        expect(pe.openai_tools).toBe(true)
        expect(pe.anthropic_tools).toBe(true)
        expect(pe.mcp).toBe(true)
      })
    })
  }
})

// ── Authority consistency ──

describe("Manifest authority profiles are consistent with risk levels", () => {
  interface Authority {
    risk_level: string
    requires_approval: boolean
    requires_hash_precondition: boolean
    side_effects: string
  }

  const files: { name: string; auth: Authority }[] = []

  for (const name of ["struct_read.v1.json", "text_replace.v1.json", "batch_edit.v1.json"]) {
    const raw = readFileSync(resolve(MANIFESTS_DIR, name), "utf-8")
    const json = JSON.parse(raw) as { authority: Authority }
    files.push({ name, auth: json.authority })
  }

  it("read tool has no approval or hash precondition", () => {
    const sr = files.find((f) => f.name.startsWith("struct_read"))!
    expect(sr.auth.risk_level).toBe("read")
    expect(sr.auth.requires_approval).toBe(false)
    expect(sr.auth.requires_hash_precondition).toBe(false)
    expect(sr.auth.side_effects).toBe("filesystem_read")
  })

  it("write tools have approval and hash precondition", () => {
    const writes = files.filter((f) => f.name !== "struct_read.v1.json")
    for (const w of writes) {
      expect(w.auth.requires_approval).toBe(true)
      expect(w.auth.requires_hash_precondition).toBe(true)
      expect(w.auth.side_effects).toBe("filesystem_write")
    }
  })

  it("batch_edit has higher risk than text_replace", () => {
    const tr = files.find((f) => f.name.startsWith("text_replace"))!
    const be = files.find((f) => f.name.startsWith("batch_edit"))!
    // Risk ordering: write_low < write_medium < write_high
    const levels = ["write_low", "write_medium", "write_high"]
    const trIdx = levels.indexOf(tr.auth.risk_level)
    const beIdx = levels.indexOf(be.auth.risk_level)
    expect(trIdx).toBeGreaterThanOrEqual(0)
    expect(beIdx).toBeGreaterThanOrEqual(0)
    expect(beIdx).toBeGreaterThan(trIdx)
  })

  it("all manifests have valid risk_level", () => {
    const valid: string[] = ["read", "write_low", "write_medium", "write_high", "exec", "network", "memory_authority"]
    for (const f of files) {
      expect(valid).toContain(f.auth.risk_level)
    }
  })
})
