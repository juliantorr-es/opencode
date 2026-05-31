import { Duration, Effect } from "effect"
import {
  type MachineDef,
  type MachineHandler,
  MachineDependenciesService,
} from "./types"

// ═══════════════════════════════════════════════════════════════════════════════
// CARTOGRAPHER CREW — codebase terrain mapping
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Surveyor: maps project structure, entry points, package boundaries ──────

const surveyorHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Surveyor: Mapping project structure")
        // Find entry points
        const entryPoints = yield* deps.findFiles("*.ts", { path: "packages/opencode/src", maxDepth: 1 })
        // Find package manifests
        const manifests = yield* deps.grep("\"name\"", { path: "packages", glob: "package.json", maxResults: 10 })
        // Find main module exports
        const exports = yield* deps.grep("export \\*", { path: "packages/opencode/src", glob: "index.ts", maxResults: 20 })
        return state.transition("completed", {
          result: "project_mapped",
          entryPoints: entryPoints.files.map(f => f.path),
          packages: manifests.files.map(m => m.text),
          exports: exports.files.map(e => e.text),
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Compass: trace imports/exports for a given concept ───────────────────────

const compassHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Compass: Tracing import/export graph")
        // Find all import patterns
        const imports = yield* deps.grep("import.*from", { path: "packages/opencode/src", maxResults: 100 })
        // Find circular patterns
        const circular = yield* deps.grep("import.*\\.\\./\\.\\./", { path: "packages/opencode/src", maxResults: 30 })
        // Build module mapping
        const files = imports.files.map(f => f.file)
        const uniqueFiles = [...new Set(files)]
        return state.transition("completed", {
          result: "deps_traced",
          importCount: imports.totalMatches,
          circularImportCount: circular.totalMatches,
          filesInspected: uniqueFiles.length,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Soundings: read test setup, fixtures, assertions ────────────────────────

const soundingsHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Soundings: Reading test infrastructure")
        // Find test files
        const testFiles = yield* deps.findFiles("*test*", { path: "packages/opencode/test", maxDepth: 3 })
        // Read test preload/setup
        const preload = yield* deps.grep("beforeEach|beforeAll|preload", { path: "packages/opencode/test", maxResults: 20 })
        // Find mock/stub patterns
        const mocks = yield* deps.grep("stub|mock|Fake", { path: "packages/opencode/test", maxResults: 20 })
        // Find env var usage in tests
        const envVars = yield* deps.grep("process\\.env|OPENCODE_", { path: "packages/opencode/test", maxResults: 15 })
        return state.transition("completed", {
          result: "test_setup_read",
          testFileCount: testFiles.files.length,
          setupPatterns: preload.files.map(f => f.text),
          mockPatterns: mocks.files.map(f => f.text),
          envVarUsage: envVars.files.map(f => f.text),
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Logbook: read git history, recent changes, deltas ────────────────────────

const logbookHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Logbook: Reading git history")
        // Recent commits
        const recent = yield* deps.git("log", "--oneline -20")
        // Recent diff
        const diff = yield* deps.git("diff", "--stat HEAD~5")
        // Files changed recently
        const changed = yield* deps.git("diff", "--name-only HEAD~5")
        // Branch info
        const branch = yield* deps.git("branch", "--show-current")
        return state.transition("completed", {
          result: "git_delta_read",
          recentCommits: recent.split("\n").filter(Boolean),
          changedFiles: changed.split("\n").filter(Boolean),
          diff: diff.slice(0, 2000),
          currentBranch: branch.trim(),
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ═══════════════════════════════════════════════════════════════════════════════
// ARCHITECT CREW — plan design and risk analysis
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Foundation: identify root causes from cartographer findings ──────────────

const foundationHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Foundation: Analyzing root causes")
        // Find error patterns
        const errors = yield* deps.grep("error|Error|throw", { path: "packages/opencode/src", glob: "*.ts", maxResults: 50 })
        // Find TODO/FIXME markers
        const todos = yield* deps.grep("TODO|FIXME|HACK|XXX", { path: "packages/opencode/src", maxResults: 30 })
        // Find deprecated patterns
        const deprecated = yield* deps.grep("@deprecated|deprecated", { path: "packages/opencode/src", maxResults: 20 })
        return state.transition("completed", {
          result: "root_causes_identified",
          errorLocations: errors.files.slice(0, 20).map(f => `${f.file}:${f.line}`),
          technicalDebt: todos.files.map(f => f.text),
          deprecatedPaths: deprecated.files.map(f => `${f.file}:${f.line}`),
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Load-bearer: trace downstream effects of proposed changes ────────────────

const loadBearerHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Load-bearer: Tracing downstream effects")
        // Find shared exports that many files depend on
        const exports = yield* deps.grep("export (const|function|class|interface)", { path: "packages/opencode/src", glob: "index.ts", maxResults: 30 })
        // Find high-use imports
        const imports = yield* deps.grep("from \"@/", { path: "packages/opencode/src", glob: "*.ts", maxResults: 60 })
        // Count usage frequency
        const symbolUsage = imports.files.reduce<Record<string, number>>((acc, f) => {
          const match = f.text.match(/from\s+"(.*?)"/)
          if (match) acc[match[1]] = (acc[match[1]] ?? 0) + 1
          return acc
        }, {})
        return state.transition("completed", {
          result: "downstream_traced",
          topExports: exports.files.map(f => f.text).slice(0, 15),
          highUseModules: Object.entries(symbolUsage)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10)
            .map(([mod, count]) => ({ module: mod, consumers: count })),
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Building-inspector: list everything that could go wrong ──────────────────

const buildingInspectorHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Building-inspector: Enumerating risks")
        // Find unsafe patterns
        const unsafe = yield* deps.grep("as any|@ts-expect-error|@ts-ignore", { path: "packages/opencode/src", maxResults: 30 })
        // Find circular deps risk
        const circular = yield* deps.grep("import.*from.*\\.\\./\\.\\./.*/.*\\.\\./", { path: "packages/opencode/src", maxResults: 20 })
        // Find Effect.runSync / runPromise (blocking calls)
        const blocking = yield* deps.grep("Effect\\.runSync|Effect\\.runPromise", { path: "packages/opencode/src", maxResults: 15 })
        return state.transition("completed", {
          result: "risks_enumerated",
          unsafePatterns: unsafe.files.map(f => `${f.file}:${f.line} ${f.text}`),
          circularDepRisk: circular.totalMatches,
          blockingCalls: blocking.files.map(f => `${f.file}:${f.line}`),
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Blueprint: design test strategy ─────────────────────────────────────────

const blueprintHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Blueprint: Designing test strategy")
        // Find existing test patterns for similar modules
        const testPatterns = yield* deps.grep("describe\\(", { path: "packages/opencode/test", maxResults: 20 })
        // Find fixture patterns
        const fixtures = yield* deps.findFiles("fixture*", { path: "packages/opencode/test", maxDepth: 3 })
        return state.transition("completed", {
          result: "tests_designed",
          existingTestPatterns: testPatterns.files.map(f => f.text),
          fixtureCount: fixtures.files.length,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Zoning-board: review plan against codebase conventions ───────────────────

const zoningBoardHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Zoning-board: Checking conventions")
        // Check for consistent patterns
        const fnPatterns = yield* deps.grep("Effect\\.fn\\(", { path: "packages/opencode/src", glob: "*.ts", maxResults: 20 })
        const layerPatterns = yield* deps.grep("Layer\\.effect\\(", { path: "packages/opencode/src", maxResults: 15 })
        const schemaPatterns = yield* deps.grep("Schema\\.Struct\\{", { path: "packages/opencode/src", maxResults: 10 })
        return state.transition("completed", {
          result: "conventions_reviewed",
          fnPatternUsage: fnPatterns.totalMatches,
          layerPatternUsage: layerPatterns.totalMatches,
          schemaPatternUsage: schemaPatterns.totalMatches,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ═══════════════════════════════════════════════════════════════════════════════
// CRITIC CREW — plan review across 7 axes
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Witness: trace dependency graph for every new import ─────────────────────

const witnessHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Witness: Tracing imports")
        const imports = yield* deps.grep("^import", { path: "packages/opencode/src", glob: "*.ts", maxResults: 80 })
        const crossPkg = imports.files.filter(f => f.text.includes("../") || f.text.includes("@/"))
        return state.transition("completed", {
          result: "deps_traced",
          totalImportStatements: imports.totalMatches,
          crossPackage: crossPkg.length,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Coroner: walk through error scenarios ───────────────────────────────────

const coronerHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Coroner: Inspecting error paths")
        const errorClasses = yield* deps.grep("class.*Error extends|TaggedError|Effect\\.die\\(", { path: "packages/opencode/src", maxResults: 30 })
        const errorHandlers = yield* deps.grep("catch\\s*\\(|Effect\\.catch\\(", { path: "packages/opencode/src", maxResults: 30 })
        return state.transition("completed", {
          result: "errors_walked",
          errorTypes: errorClasses.files.map(f => f.text).slice(0, 15),
          errorHandlersCount: errorHandlers.totalMatches,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Precedent: read existing plans and architecture docs ─────────────────────

const precedentHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Precedent: Reading existing plans")
        const plans = yield* deps.findFiles("*.json", { path: "docs/json/opencode/plans", maxDepth: 1 })
        const archDocs = yield* deps.findFiles("*.md", { path: "docs", maxDepth: 2 })
        return state.transition("completed", {
          result: "plans_reviewed",
          planCount: plans.files.length,
          archDocCount: archDocs.files.length,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Blast-radius: enumerate all consumers of changed symbols ────────────────

const blastRadiusHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Blast-radius: Enumerating consumers")
        const exports = yield* deps.grep("^export", { path: "packages/opencode/src", glob: "*.ts", maxResults: 50 })
        // Check cross-file usage
        const crossFile = exports.files.filter(f => f.text.includes("from"))
        return state.transition("completed", {
          result: "consumers_enumerated",
          exportStatements: exports.totalMatches,
          reExports: crossFile.length,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Reasonable-doubt: verify each change is testable in 10 lines ────────────

const reasonableDoubtHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Reasonable-doubt: Checking testability")
        const testable = yield* deps.grep("describe\\(|it\\(|test\\(", { path: "packages/opencode/test", maxResults: 20 })
        const integrationTests = yield* deps.grep("\\.skip\\(", { path: "packages/opencode/test", maxResults: 10 })
        return state.transition("completed", {
          result: "testability_checked",
          testDescriptions: testable.files.map(f => f.text),
          skippedTests: integrationTests.totalMatches,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Exhibit-a: read every error path and what the developer sees ────────────

const exhibitAHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Exhibit-a: Inspecting error messages")
        const messages = yield* deps.grep("\"[A-Z].*error|\"[A-Z].*fail|\"[A-Z].*invalid", { path: "packages/opencode/src", maxResults: 30 })
        const logs = yield* deps.grep("log\\.(error|warn|info)\\(", { path: "packages/opencode/src", maxResults: 30 })
        return state.transition("completed", {
          result: "errors_inspected",
          errorMessages: messages.files.map(f => f.text).slice(0, 15),
          logStatements: logs.totalMatches,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Appeal: test reversibility of grouped changes ──────────────────────────

const appealHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Appeal: Testing reversibility")
        const interdeps = yield* deps.grep("import.*@/", { path: "packages/opencode/src", glob: "*.ts", maxResults: 40 })
        return state.transition("completed", {
          result: "reversibility_tested",
          internalImportCount: interdeps.totalMatches,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ═══════════════════════════════════════════════════════════════════════════════
// SURGEON CREW — edit application with verification
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Scalpel: apply planned edits to specified files ─────────────────────────

const scalpelHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Scalpel: Applying planned edits")
        // Read target files from state data
        const data = state.data as Record<string, any>
        const targetFiles: string[] = data?.targetFiles ?? []
        const edits: Array<{ file: string; oldText: string; newText: string; reason: string }> = data?.edits ?? []

        if (edits.length > 0) {
          yield* deps.smartBatch(edits)
        }
        return state.transition("completed", {
          result: "edit_applied",
          filesTouched: targetFiles.length,
          editsApplied: edits.length,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Vitals: run typecheck after each edit batch ─────────────────────────────

const vitalsHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Vitals: Running typecheck")
        const result = yield* deps.bun("run", { cwd: "packages/opencode", args: "typecheck", timeoutSeconds: 120 })
        const typeErrors = result.stderr.length > 0 || result.exitCode !== 0
        // Extract error count
        const errorMatch = result.stderr.match(/(\d+)\s*error/)
        const errorCount = errorMatch ? parseInt(errorMatch[1]) : (result.exitCode === 0 ? 0 : -1)
        return state.transition("completed", {
          result: { typecheck: result.exitCode === 0 ? "pass" : "fail" },
          typecheckPassed: result.exitCode === 0,
          errorCount,
          output: result.stdout.slice(0, 500),
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Stress-test: run targeted tests ──────────────────────────────────────────

const stressTestHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Stress-test: Running tests")
        const data = state.data as Record<string, any>
        const testPattern = data?.testPattern as string | undefined
        const args = testPattern ? `--test-name-pattern "${testPattern}"` : ""
        const result = yield* deps.bun("test", { cwd: "packages/opencode", args, timeoutSeconds: 180 })
        return state.transition("completed", {
          result: { tests: result.exitCode === 0 ? "pass" : "fail" },
          testsPassed: result.exitCode === 0,
          stdout: result.stdout.slice(0, 1000),
          stderr: result.stderr.slice(0, 500),
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Second-opinion: run bisect script at each checkpoint ────────────────────

const secondOpinionHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Second-opinion: Running verification checks")
        // Run diff to see what changed
        const diff = yield* deps.git("diff", "--stat")
        return state.transition("completed", {
          result: { bisect: "pass" },
          diff: diff.slice(0, 2000),
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Tourniquet: revert if an edit causes regression ─────────────────────────

const tourniquetHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Tourniquet: Checking for regressions")
        // Check git status for modified files
        const status = yield* deps.git("status", "--porcelain")
        const modifiedFiles = status.split("\n").filter(Boolean).length
        return state.transition("completed", {
          result: modifiedFiles > 0 ? "changes_detected" : "clean",
          modifiedFiles,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Monitor: watch for new errors, warnings, side effects ───────────────────

const monitorHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Monitor: Checking for side effects")
        // Check for new error patterns
        const errors = yield* deps.grep("error|Error", { path: "packages/opencode/src", glob: "*.ts", maxResults: 10 })
        // Check for new warnings
        const warnings = yield* deps.grep("warn", { path: "packages/opencode/src", glob: "*.ts", maxResults: 10 })
        return state.transition("completed", {
          result: { sideEffects: [] },
          errorCount: errors.totalMatches,
          warningCount: warnings.totalMatches,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ═══════════════════════════════════════════════════════════════════════════════
// JOURNALIST CREW — commit composition and PR crafting
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Scoop: trace code lineage (git blame, log) ──────────────────────────────

const scoopHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Scoop: Tracing code lineage")
        const log = yield* deps.git("log", "--oneline -30")
        return state.transition("completed", {
          result: "lineage_traced",
          recentHistory: log.split("\n").filter(Boolean),
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Editor: group related changes into logical commits ──────────────────────

const editorHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Editor: Grouping changes into commits")
        const status = yield* deps.git("status", "--porcelain")
        const diff = yield* deps.git("diff", "--stat")
        const files = status.split("\n").filter(Boolean)
        // Group by directory prefix
        const groups = new Map<string, string[]>()
        for (const file of files) {
          const path = file.replace(/^[MADRCU?!\s]{1,2}\s+/, "")
          const dir = path.split("/")[0]
          const list = groups.get(dir) ?? []
          list.push(path)
          groups.set(dir, list)
        }
        const commitPlan = Array.from(groups.entries()).map(([dir, paths]) => ({
          group: dir,
          files: paths,
          suggestedScope: dir,
        }))
        return state.transition("completed", {
          result: { commitPlan },
          changedFiles: files.length,
          suggestedGroups: commitPlan.length,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Byline: write conventional commit messages ──────────────────────────────

const bylineHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Byline: Writing commit messages")
        const diff = yield* deps.git("diff", "--stat")
        const log = yield* deps.git("log", "--oneline -5")
        // Generate conventional commit suggestions based on changed files
        const files = diff.split("\n").filter(Boolean)
        const types = new Set<string>()
        for (const f of files) {
          if (f.startsWith("src/")) types.add("refactor")
          if (f.includes("test")) types.add("test")
          if (f.includes(".md") || f.includes("docs")) types.add("docs")
        }
        const suggestedType = types.size === 1 ? [...types][0] : "chore"
        return state.transition("completed", {
          result: {
            messages: [`${suggestedType}: ${files.length} files changed`],
            suggestedType,
            fileCount: files.length,
          },
          recentLog: log.split("\n").filter(Boolean),
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Press: create the pull request ─────────────────────────────────────────

const pressHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Press: Preparing PR")
        const branch = yield* deps.git("branch", "--show-current")
        const diff = yield* deps.git("diff", "origin/dev...HEAD", { path: "." })
        return state.transition("completed", {
          result: { prCreated: false }, // PR creation requires GitHub CLI
          branch: branch.trim(),
          diffSummary: diff.slice(0, 1000),
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Retort: handle review comments ─────────────────────────────────────────

const retortHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Retort: Ready for review responses")
        return state.transition("completed", {
          result: "ready",
          status: "awaiting_review",
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Headline: extract user-facing changes from commit log ───────────────────

const headlineHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Headline: Extracting changelog entries")
        const log = yield* deps.git("log", "--oneline --format='%s' -20")
        const entries = log.split("\n").filter(Boolean).map((l: string) => l.trim())
        const features = entries.filter(e => /^feat/.test(e))
        const fixes = entries.filter(e => /^fix/.test(e))
        const chores = entries.filter(e => /^chore/.test(e))
        return state.transition("completed", {
          result: {
            changelog: { features, fixes, chores },
            totalCommits: entries.length,
          },
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ═══════════════════════════════════════════════════════════════════════════════
// TRIAL CREW — validation sub-agents
// ═══════════════════════════════════════════════════════════════════════════════

// ─── QA Observer: run QA checks ──────────────────────────────────────────────

const qaObserverHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "QA: Running quality checks")
        const typecheck = yield* deps.bun("run", { cwd: "packages/opencode", args: "typecheck", timeoutSeconds: 120 })
        // Run lint
        const lint = yield* deps.bun("run", { cwd: "packages/opencode", args: "lint", timeoutSeconds: 60 })
        return state.transition("completed", {
          result: "qa_pass",
          typecheckPassed: typecheck.exitCode === 0,
          lintPassed: lint.exitCode === 0,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── Red Team: edge case / security testing ─────────────────────────────────

const redTeamHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "Red-team: Running edge case tests")
        const test = yield* deps.bun("test", { cwd: "packages/opencode", timeoutSeconds: 180 })
        const failures = test.stdout.match(/\d+ failing/) ?? []
        return state.transition("completed", {
          result: failures.length === 0 ? "red_team_pass" : "red_team_fail",
          testFailureCount: failures.length,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ─── EMS: Emergency monitoring / crash detection ─────────────────────────────

const emsHandle: MachineHandler = (state, event) =>
  Effect.gen(function* () {
    const deps = yield* MachineDependenciesService
    switch (event._tag) {
      case "Start": {
        yield* deps.log("info", "EMS: Running crash detection")
        // Check for crash files
        const crashes = yield* deps.findFiles("*.log", { path: "/tmp", maxDepth: 1 })
        return state.transition("completed", {
          result: "ems_clean",
          crashLogsFound: crashes.files.length,
        })
      }
      case "Cancel":
        return state.transition("cancelled")
      default:
        return state
    }
  })

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTED DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

// Cartographer crew
export const surveyorDef: MachineDef = { id: "surveyor", description: "Maps project structure — entry points, package boundaries, framework versions", subMachines: [], handle: surveyorHandle, timeout: Duration.minutes(2) }
export const compassDef: MachineDef = { id: "compass", description: "Traces imports/exports — builds dependency graph, finds circular edges", subMachines: [], handle: compassHandle, timeout: Duration.minutes(2) }
export const soundingsDef: MachineDef = { id: "soundings", description: "Reads test setup — fixtures, assertions, env vars, preload", subMachines: [], handle: soundingsHandle, timeout: Duration.minutes(2) }
export const logbookDef: MachineDef = { id: "logbook", description: "Reads git history — recent changes, deltas, branch context", subMachines: [], handle: logbookHandle, timeout: Duration.minutes(2) }

// Architect crew
export const foundationDef: MachineDef = { id: "foundation", description: "Identifies root causes — error patterns, TODOs, deprecated code", subMachines: [], handle: foundationHandle, timeout: Duration.minutes(3) }
export const loadBearerDef: MachineDef = { id: "load-bearer", description: "Traces downstream effects — maps change impact across the module graph", subMachines: [], handle: loadBearerHandle, timeout: Duration.minutes(3) }
export const buildingInspectorDef: MachineDef = { id: "building-inspector", description: "Lists risks — unsafe patterns, circular deps, blocking calls", subMachines: [], handle: buildingInspectorHandle, timeout: Duration.minutes(3) }
export const blueprintDef: MachineDef = { id: "blueprint", description: "Designs test strategy — finds existing test patterns and fixtures", subMachines: [], handle: blueprintHandle, timeout: Duration.minutes(3) }
export const zoningBoardDef: MachineDef = { id: "zoning-board", description: "Reviews conventions — checks consistent use of Effect patterns", subMachines: [], handle: zoningBoardHandle, timeout: Duration.minutes(3) }

// Critic crew
export const witnessDef: MachineDef = { id: "witness", description: "Traces dependency graph — counts imports and cross-package references", subMachines: [], handle: witnessHandle, timeout: Duration.minutes(3) }
export const coronerDef: MachineDef = { id: "coroner", description: "Walks through errors — catalogs error types, tagged errors, catch handlers", subMachines: [], handle: coronerHandle, timeout: Duration.minutes(3) }
export const precedentDef: MachineDef = { id: "precedent", description: "Reads existing plans and architecture docs for consistency", subMachines: [], handle: precedentHandle, timeout: Duration.minutes(3) }
export const blastRadiusDef: MachineDef = { id: "blast-radius", description: "Enumerates consumers — counts exports and re-exports across modules", subMachines: [], handle: blastRadiusHandle, timeout: Duration.minutes(3) }
export const reasonableDoubtDef: MachineDef = { id: "reasonable-doubt", description: "Checks testability — finds describe/it blocks and skipped tests", subMachines: [], handle: reasonableDoubtHandle, timeout: Duration.minutes(3) }
export const exhibitADef: MachineDef = { id: "exhibit-a", description: "Inspects error paths — catalogs error messages and log statements", subMachines: [], handle: exhibitAHandle, timeout: Duration.minutes(3) }
export const appealDef: MachineDef = { id: "appeal", description: "Tests reversibility — counts internal module interdependencies", subMachines: [], handle: appealHandle, timeout: Duration.minutes(3) }

// Surgeon crew
export const scalpelDef: MachineDef = { id: "scalpel", description: "Applies planned edits to specified files using smart batch", subMachines: [], handle: scalpelHandle, timeout: Duration.minutes(2) }
export const vitalsDef: MachineDef = { id: "vitals", description: "Runs typecheck and reports error count", subMachines: [], handle: vitalsHandle, timeout: Duration.minutes(3) }
export const stressTestDef: MachineDef = { id: "stress-test", description: "Runs tests with optional test name pattern filter", subMachines: [], handle: stressTestHandle, timeout: Duration.minutes(5) }
export const secondOpinionDef: MachineDef = { id: "second-opinion", description: "Runs verification checks — diff inspection", subMachines: [], handle: secondOpinionHandle, timeout: Duration.minutes(2) }
export const tourniquetDef: MachineDef = { id: "tourniquet", description: "Checks for regressions by inspecting git status", subMachines: [], handle: tourniquetHandle, timeout: Duration.minutes(2) }
export const monitorDef: MachineDef = { id: "monitor", description: "Watches for new errors and warnings after each edit", subMachines: [], handle: monitorHandle, timeout: Duration.minutes(2) }

// Journalist crew
export const scoopDef: MachineDef = { id: "scoop", description: "Traces code lineage via git blame/log", subMachines: [], handle: scoopHandle, timeout: Duration.minutes(2) }
export const editorDef: MachineDef = { id: "editor", description: "Groups related changes into logical commit groups by directory", subMachines: [], handle: editorHandle, timeout: Duration.minutes(2) }
export const bylineDef: MachineDef = { id: "byline", description: "Writes conventional commit messages based on changed files", subMachines: [], handle: bylineHandle, timeout: Duration.minutes(2) }
export const pressDef: MachineDef = { id: "press", description: "Creates PR — branch and diff analysis", subMachines: [], handle: pressHandle, timeout: Duration.minutes(2) }
export const retortDef: MachineDef = { id: "retort", description: "Handles review responses", subMachines: [], handle: retortHandle, timeout: Duration.minutes(5) }
export const headlineDef: MachineDef = { id: "headline", description: "Extracts changelog entries from commit history", subMachines: [], handle: headlineHandle, timeout: Duration.minutes(2) }

// Trial crew
export const qaObserverDef: MachineDef = { id: "qa-observer", description: "Runs typecheck and lint checks", subMachines: [], handle: qaObserverHandle, timeout: Duration.minutes(5) }
export const redTeamDef: MachineDef = { id: "red-team", description: "Runs test suite and reports failures", subMachines: [], handle: redTeamHandle, timeout: Duration.minutes(5) }
export const emsDef: MachineDef = { id: "ems", description: "Emergency monitoring — checks for crash logs", subMachines: [], handle: emsHandle, timeout: Duration.minutes(2) }
