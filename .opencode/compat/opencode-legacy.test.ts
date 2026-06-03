import { describe, test, expect } from "bun:test"
import { getEnv, ENV_ALIASES, OPENCODE_LEGACY_COMPAT } from "../../packages/opencode/src/compat/opencode-legacy"

describe("OpenCode Legacy Compatibility", () => {
  test("all env aliases point to TRIBUNUS_* canonical", () => {
    for (const [suffix, canonical] of Object.entries(ENV_ALIASES)) {
      expect(canonical).toMatch(/^TRIBUNUS_/)
    }
  })

  test("deprecation metadata is present", () => {
    expect(OPENCODE_LEGACY_COMPAT.introduced).toBeTruthy()
    expect(OPENCODE_LEGACY_COMPAT.removeAfter).toBeTruthy()
  })

  test("getEnv resolves canonical over legacy", () => {
    process.env.TRIBUNUS_STATE_HOME = "/tmp/tribunus"
    process.env.OPENCODE_STATE_HOME = "/tmp/opencode"
    const result = getEnv("STATE_HOME")
    expect(result).toBe("/tmp/tribunus")
    delete process.env.TRIBUNUS_STATE_HOME
    delete process.env.OPENCODE_STATE_HOME
  })

  test("getEnv falls back to legacy when canonical is absent", () => {
    delete process.env.TRIBUNUS_STATE_HOME
    process.env.OPENCODE_STATE_HOME = "/tmp/opencode"
    const result = getEnv("STATE_HOME")
    expect(result).toBe("/tmp/opencode")
    delete process.env.OPENCODE_STATE_HOME
  })
})
