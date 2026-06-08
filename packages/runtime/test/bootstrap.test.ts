import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { runBootstrap, topologicalSort, BOOT_DEPENDENCIES } from "../src/runtime/bootstrap"

describe("Bootstrap Dependency Assembly", () => {
  test("topological sort respects dependency order", () => {
    const sorted = topologicalSort(BOOT_DEPENDENCIES)
    const names = sorted.map((d) => d.name)
    for (const dep of BOOT_DEPENDENCIES) {
      for (const up of dep.dependsOn) {
        expect(names.indexOf(up)).toBeLessThan(names.indexOf(dep.name))
      }
    }
  })

  test("all dependencies are included in sort output", () => {
    const sorted = topologicalSort(BOOT_DEPENDENCIES)
    expect(sorted.length).toBe(BOOT_DEPENDENCIES.length)
  })

  test("bootstrap completes with all health probes passing", async () => {
    const report = await Effect.runPromise(runBootstrap())
    expect(report.ready).toBe(true)
    expect(report.passed).toBe(BOOT_DEPENDENCIES.length)
    expect(report.failed).toBe(0)
    expect(report.criticalFailures.length).toBe(0)
    expect(report.totalDurationMs).toBeGreaterThan(0)
  })

  test("each check has timing recorded", async () => {
    const report = await Effect.runPromise(runBootstrap())
    for (const check of report.checks) {
      if (check.status !== "skipped") {
        expect(check.durationMs).toBeGreaterThanOrEqual(0)
      }
    }
  })
})
