import { registerTool } from "../../server/registry.js"
import type { Capability } from "../../governance/capabilities.js"
import { governedRun } from "../../governance/subprocess.js"
import { validateOrReject } from "../../governance/paths.js"
import { sha256Hex } from "../../shared/digests.js"
import { readFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import * as crypto from "node:crypto"

const COMPUTE_NATIVE_DIR = process.env.TRIBUNUS_COMPUTE_DIR || resolve(process.cwd(), "packages/compute-native")
const HF_API = process.env.HF_API || "https://huggingface.co/api"
const HF_TOKEN = process.env.HF_TOKEN || ""
const MACMON_URL = process.env.MACMONT_URL || "http://localhost:9090/metrics"
const EVIDENCE_DB = process.env.TRIBUNUS_EVIDENCE_DB || join(COMPUTE_NATIVE_DIR, "evidence.duckdb")
const MLX_MODEL_DIR = process.env.TRIBUNUS_MLX_MODEL_DIR || join(homedir(), ".cache/tribunus/models")

function hfHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" }
  if (HF_TOKEN) h["Authorization"] = `Bearer ${HF_TOKEN}`
  return h
}

async function hfGet(path: string) {
  const res = await fetch(`${HF_API}${path}`, { headers: hfHeaders() })
  const text = await res.text()
  let body: unknown = text
  try { body = JSON.parse(text) } catch {}
  return { status: res.status, body }
}

function ok(result: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] } }

function t(name: string, desc: string, props: Record<string, unknown>, req: string[], caps: Capability[], ms: number, fn: (a: Record<string, unknown>) => Promise<unknown>) {
  registerTool({ name, description: desc, inputSchema: { type: "object", properties: props as any, required: req }, requiredCapabilities: caps, timeoutMs: ms, execute: (_ctx, input) => fn(input) })
}

const _macmonSessions = new Map<string, { startTime: number; interval: number; samples: any[][] }>()

async function macmonFetch(): Promise<any[]> {
  const res = await fetch(MACMON_URL)
  if (!res.ok) throw new Error(`macmon fetch failed: ${res.status}`)
  const raw = await res.text()
  const metrics: any[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const spaceIdx = trimmed.lastIndexOf(" ")
    if (spaceIdx === -1) continue
    const nameAndLabels = trimmed.slice(0, spaceIdx)
    const value = parseFloat(trimmed.slice(spaceIdx + 1))
    if (isNaN(value)) continue
    const braceIdx = nameAndLabels.indexOf("{")
    if (braceIdx === -1) {
      metrics.push({ name: nameAndLabels, value, labels: {} })
    } else {
      const name = nameAndLabels.slice(0, braceIdx)
      const labelsStr = nameAndLabels.slice(braceIdx + 1, nameAndLabels.indexOf("}"))
      const labels: Record<string, string> = {}
      for (const pair of labelsStr.split(",")) {
        const [k, v] = pair.split("=").map((s: string) => s.replace(/"/g, "").trim())
        if (k && v !== undefined) labels[k] = v
      }
      metrics.push({ name, value, labels })
    }
  }
  return metrics
}

export function registerComputeTools(): void {
  // HuggingFace
  t("hf_search_models", "Search HuggingFace Hub.", {
    query: { type: "string" }, limit: { type: "number" }, author: { type: "string" }, pipeline_tag: { type: "string" },
  }, ["query"], ["model:acquire"], 30_000, async (a) => {
    const params: Record<string, string> = {}
    if (a.query) params.search = String(a.query)
    if (a.author) params.author = String(a.author)
    if (a.pipeline_tag) params.pipeline_tag = String(a.pipeline_tag)
    if (a.limit) params.limit = String(Math.min(Number(a.limit), 100))
    params.expand = "author,downloads,likes,pipeline_tag,safetensors"
    const p = new URLSearchParams(params).toString()
    return ok(await hfGet(`/models?${p}`))
  })

  t("hf_get_model_info", "Get model metadata.", { model_id: { type: "string" } }, ["model_id"], ["model:acquire"], 30_000, async (a) => {
    const modelId = a.model_id as string
    const [info, files] = await Promise.all([hfGet(`/models/${modelId}`), hfGet(`/models/${modelId}?expand[]=siblings`)])
    const result: Record<string, unknown> = { model_id: modelId }
    if (info.status === 200 && typeof info.body === "object" && info.body) {
      const m = info.body as Record<string, unknown>
      result.description = m.description; result.tags = m.tags; result.pipeline_tag = m.pipeline_tag
      result.likes = m.likes; result.downloads = m.downloads; result.license = m.license
      if (m.safetensors) result.safetensors_parameters = (m.safetensors as Record<string, unknown>).parameters
    }
    if (files.status === 200 && typeof files.body === "object" && files.body) {
      const f = files.body as Record<string, unknown>
      result.files = ((f.siblings || []) as any[]).map((s: any) => ({ name: s.rfilename, size: s.size, sha256: s.blob_id ?? s.lfs?.sha256 }))
    }
    return ok(result)
  })

  t("hf_download_model", "Two-phase model download.", {
    model_id: { type: "string" }, revision: { type: "string" }, target_dir: { type: "string" }, include: { type: "string" },
  }, ["model_id"], ["model:acquire"], 600_000, async (a) => {
    const modelId = a.model_id as string
    const targetDir = (a.target_dir as string) || join(MLX_MODEL_DIR, modelId.replace("/", "_"))
    const revision = (a.revision as string) || ""
    const include = (a.include as string) || "*.safetensors,*.json,tokenizer*"
    let pinnedRevision = revision
    if (!pinnedRevision) {
      const info = await hfGet(`/models/${modelId}`)
      if (info.status !== 200) return { content: [{ type: "text" as const, text: `Failed to resolve: ${info.status}` }], isError: true }
      const m = info.body as Record<string, unknown>
      pinnedRevision = (m.sha || m._id || "main") as string
    }
    const staging = join(targetDir, `.staging-${Date.now()}`)
    await mkdir(staging, { recursive: true })
    const dlResult = await governedRun("bun", ["x", "huggingface-cli", "download", modelId, "--revision", pinnedRevision, "--local-dir", staging, "--include", include], { timeout: 600_000 })
    if (!dlResult.ok) return { content: [{ type: "text" as const, text: `Download failed: ${dlResult.stderr}` }], isError: true }
    const finalDir = join(targetDir, `${modelId.replace("/", "_")}-${pinnedRevision.slice(0, 12)}`)
    try { await (await import("node:fs/promises")).rename(staging, finalDir) } catch (e) {
      return { content: [{ type: "text" as const, text: `Failed to rename staging: ${e}` }], isError: true }
    }
    return ok({ model_id: modelId, pinned_revision: pinnedRevision, install_dir: finalDir, download_stderr: dlResult.stderr })
  })

  // macmon
  t("macmon_metrics", "Read Apple Silicon metrics.", { filter: { type: "string" } }, [], ["hardware:monitor"], 15_000, async (a) => {
    const filter = (a.filter as string) || ""
    const metrics = await macmonFetch()
    const filtered = filter ? metrics.filter((m: any) => m.name.toLowerCase().includes(filter.toLowerCase())) : metrics
    const summary: Record<string, number> = {}
    for (const m of filtered) summary[m.name] = m.value
    return ok({ count: filtered.length, metrics: summary })
  })

  t("macmon_session", "Session-oriented hardware monitor.", {
    action: { type: "string", enum: ["start","sample","stop"] }, session_id: { type: "string" }, interval_ms: { type: "number" },
  }, ["action"], ["hardware:monitor"], 120_000, async (a) => {
    const action = a.action as string
    if (action === "start") {
      const sid = (a.session_id as string) || crypto.randomUUID()
      const interval = (a.interval_ms as number) || 100
      _macmonSessions.set(sid, { startTime: Date.now(), interval, samples: [] })
      const doSample = async () => {
        const session = _macmonSessions.get(sid)
        if (!session) return
        try { session.samples.push(await macmonFetch()) } catch {}
        if (_macmonSessions.has(sid)) setTimeout(doSample, interval)
      }
      setTimeout(doSample, interval)
      return ok({ action: "start", session_id: sid })
    }
    const sid = a.session_id as string
    if (!sid || !_macmonSessions.has(sid)) return { content: [{ type: "text" as const, text: `Session ${sid} not found` }], isError: true }
    const session = _macmonSessions.get(sid)!
    if (action === "sample") {
      const metrics = await macmonFetch()
      session.samples.push(metrics)
      return ok({ action: "sample", session_id: sid, sample_index: session.samples.length - 1 })
    }
    _macmonSessions.delete(sid)
    return ok({ action: "stop", session_id: sid, duration_ms: Date.now() - session.startTime, sample_count: session.samples.length })
  })

  // Cargo
  t("cargo_build", "Build compute kernel.", {
    profile: { type: "string" }, features: { type: "string" }, target: { type: "string" }, release: { type: "boolean" },
  }, [], ["compute:build"], 600_000, async (a) => {
    const profile = (a.profile as string) || "image-build"
    const features = (a.features as string) || ""
    const target = (a.target as string) || ""
    const args = ["build"]
    if (a.release) args.push("--release")
    else if (profile) args.push("--profile", profile)
    if (features) args.push("--features", features)
    if (target) args.push("--target", target)
    const gitStatus = await governedRun("git", ["status", "--porcelain"], { cwd: COMPUTE_NATIVE_DIR, timeout: 10_000 })
    const isDirty = gitStatus.ok && gitStatus.stdout.trim().length > 0
    if (isDirty && !process.env.TRIBUNUS_ALLOW_DIRTY_BUILD) return { content: [{ type: "text" as const, text: `Dirty tree. Set TRIBUNUS_ALLOW_DIRTY_BUILD=1 to override.` }], isError: true }
    const result = await governedRun("cargo", args, { cwd: COMPUTE_NATIVE_DIR, timeout: 600_000 })
    if (!result.ok) return { content: [{ type: "text" as const, text: `Build failed: ${result.stderr}` }], isError: true }
    return ok({ exit_code: result.code, dirty: isDirty, stderr: result.stderr })
  })

  t("cargo_bench", "Run Criterion benchmarks.", {
    bench: { type: "string" }, profile: { type: "string" }, features: { type: "string" },
  }, [], ["compute:bench"], 600_000, async (a) => {
    const args = ["bench"]
    if (a.profile) args.push("--profile", String(a.profile))
    if (a.features) args.push("--features", String(a.features))
    if (a.bench) args.push("--bench", String(a.bench))
    const result = await governedRun("cargo", args, { cwd: COMPUTE_NATIVE_DIR, timeout: 600_000 })
    if (!result.ok) return { content: [{ type: "text" as const, text: `Bench failed: ${result.stderr}` }], isError: true }
    return ok({ exit_code: result.code, stdout: result.stdout })
  })

  t("cargo_check", "Check without codegen.", {
    features: { type: "string" }, profile: { type: "string" },
  }, [], ["compute:build"], 300_000, async (a) => {
    const args = ["check"]
    if (a.profile) args.push("--profile", String(a.profile))
    if (a.features) args.push("--features", String(a.features))
    const result = await governedRun("cargo", args, { cwd: COMPUTE_NATIVE_DIR, timeout: 300_000 })
    if (!result.ok) return { content: [{ type: "text" as const, text: `Check failed: ${result.stderr}` }], isError: true }
    return ok({ exit_code: result.code })
  })

  // Metal
  t("metal_compile", "Compile Metal shader.", {
    source: { type: "string" }, output: { type: "string" }, opt: { type: "string", enum: ["none","fast","faster","fastest"] },
  }, ["source"], ["compute:build"], 60_000, async (a) => {
    const source = validateOrReject(String(a.source), false)
    const airOut = (a.output as string) || source.replace(/\.metal$/, ".air")
    const opt = (a.opt as string) || "fastest"
    const result = await governedRun("xcrun", ["-sdk","macosx","metal","-O"+opt,"-c",source,"-o",airOut,"-mmacosx-version-min=14.0","-arch","arm64"], { timeout: 60_000 })
    if (!result.ok) return { content: [{ type: "text" as const, text: `Compile failed: ${result.stderr}` }], isError: true }
    return ok({ source, output: airOut, optimization: opt })
  })

  t("xctrace_record", "Profile binary.", {
    binary: { type: "string" }, args: { type: "string" }, template: { type: "string" }, output: { type: "string" }, time_limit: { type: "number" },
  }, ["binary"], ["compute:profile"], 120_000, async (a) => {
    const binary = validateOrReject(String(a.binary), false)
    const template = (a.template as string) || "Metal System Trace"
    const timeLimit = String((a.time_limit as number) || 30) + "s"
    const ts = Date.now()
    const evidenceDir = join(COMPUTE_NATIVE_DIR, "evidence", "traces")
    await mkdir(evidenceDir, { recursive: true })
    const output = (a.output as string) || join(evidenceDir, `tribunus-profile-${ts}.trace`)
    const binArgs = (a.args as string) || ""
    const result = await governedRun("xcrun", ["xctrace","record","--template",template,"--time-limit",timeLimit,"--output",output,"--launch","--",binary,...(binArgs?binArgs.split(" "):[])], { timeout: (Number(a.time_limit||30)+30)*1000 })
    if (!result.ok) return { content: [{ type: "text" as const, text: `xctrace failed: ${result.stderr}` }], isError: true }
    return ok({ binary, output, template })
  })

  // DuckDB
  t("duckdb_query", "Read-only SQL on evidence DB.", {
    sql: { type: "string" }, db_path: { type: "string" }, max_rows: { type: "number" }, max_bytes: { type: "number" },
  }, ["sql"], ["evidence:read"], 30_000, async (a) => {
    const sql = (a.sql as string).trim()
    const uc = sql.toUpperCase()
    if (!["SELECT","WITH","DESCRIBE","SHOW","EXPLAIN","PRAGMA"].some(p => uc.startsWith(p))) return { content: [{ type: "text" as const, text: "Only SELECT/WITH/DESCRIBE/SHOW/EXPLAIN/PRAGMA allowed" }], isError: true }
    const maxRows = (a.max_rows as number) || 1000
    const maxBytes = (a.max_bytes as number) || 1048576
    const db = await import("duckdb")
    const conn = new db.Database((a.db_path as string) || EVIDENCE_DB)
    const result = conn.all(`${sql} LIMIT ${maxRows}`)
    conn.close()
    const rows = result as unknown as unknown[]
    const serialized = JSON.stringify(rows)
    if (serialized.length > maxBytes) return { content: [{ type: "text" as const, text: `Result exceeds ${maxBytes} byte limit` }], isError: true }
    return ok({ sql, rows, row_count: rows.length, byte_count: serialized.length })
  })

  t("duckdb_list_tables", "List evidence DB tables.", {
    db_path: { type: "string" }, include_counts: { type: "boolean" },
  }, [], ["evidence:read"], 15_000, async (a) => {
    const includeCounts = a.include_counts === true
    const db = await import("duckdb")
    const conn = new db.Database((a.db_path as string) || EVIDENCE_DB)
    const sql = includeCounts ? "SELECT table_name, estimated_visible_rows as row_count FROM duckdb_tables() ORDER BY table_name" : "SELECT table_name FROM duckdb_tables() ORDER BY table_name"
    const tables = conn.all(sql) as unknown as unknown[]
    conn.close()
    return ok({ database: a.db_path || EVIDENCE_DB, tables, table_count: tables.length })
  })

  t("duckdb_admin_execute", "Admin SQL on evidence DB.", {
    sql: { type: "string" }, db_path: { type: "string" },
  }, ["sql"], ["evidence:admin"], 30_000, async (a) => {
    const db = await import("duckdb")
    const conn = new db.Database((a.db_path as string) || EVIDENCE_DB)
    conn.run(a.sql as string)
    conn.close()
    return ok({ message: "Executed successfully" })
  })

  // MLX
  t("mlx_inference", "Run MLX inference.", {
    model_id: { type: "string" }, prompt: { type: "string" }, mode: { type: "string", enum: ["generate","decode_one"] },
    max_tokens: { type: "number" }, temperature: { type: "number" }, seed: { type: "number" },
  }, ["model_id"], ["compute:inference"], 300_000, async (a) => {
    const mode = (a.mode as string) || "generate"
    const prompt = (a.prompt as string) || ""
    const modelId = a.model_id as string
    const maxTokens = a.max_tokens || 256
    const temp = a.temperature ?? 0.7
    const code: string[] = []
    if (a.seed) code.push(`import random; random.seed(${a.seed})`)
    if (mode === "decode_one") {
      code.push("from mlx_lm import load", "import mlx.core as mx", `model, tokenizer = load("${modelId}")`, `ids = mx.array([1])`, "logits = model(ids)", "print('OK')")
    } else {
      code.push("from mlx_lm import load, generate", `model, tokenizer = load("${modelId}")`, `response = generate(model, tokenizer, prompt="${prompt.replace(/"/g,'\\"')}", max_tokens=${maxTokens}, temp=${temp})`, "print(response)")
    }
    const tmpDir = join("/tmp", `tribunus-mlx-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const tmpScript = join(tmpDir, "inference.py")
    await (await import("node:fs/promises")).writeFile(tmpScript, code.join("\n"), { mode: 0o600 })
    try {
      const result = await governedRun("python3", [tmpScript], { timeout: 300_000 })
      if (!result.ok) return { content: [{ type: "text" as const, text: `MLX failed: ${result.stderr}` }], isError: true }
      return ok({ model_id: modelId, response: result.stdout.trim() })
    } finally {
      await (await import("node:fs/promises")).unlink(tmpScript).catch(() => {})
      await (await import("node:fs/promises")).rmdir(tmpDir).catch(() => {})
    }
  })

  t("mlx_benchmark", "Benchmark MLX inference.", {
    model_id: { type: "string" }, prompt_length: { type: "number" }, max_tokens: { type: "number" }, iterations: { type: "number" },
  }, ["model_id"], ["compute:bench","compute:inference"], 600_000, async (a) => {
    const modelId = a.model_id as string
    const promptLen = a.prompt_length || 128
    const maxTokens = a.max_tokens || 256
    const iters = Math.max(Number(a.iterations || 10), 3)
    const code = ["from mlx_lm import load, generate", "import time", `model, tokenizer = load("${modelId}")`, `prompt = "Benchmark test. " * ${promptLen}`, "print('iterations', ${iters})", "latencies = []", `for i in range(${iters}):`, "    t0 = time.perf_counter()", `    response = generate(model, tokenizer, prompt=prompt, max_tokens=${maxTokens})`, "    dt = time.perf_counter() - t0", "    tokens = len(tokenizer.encode(response))", "    latencies.append(dt)", "    print(f'iter_{i}_tokens_per_sec', round(tokens/dt, 1))", "latencies.sort()", "if len(latencies) >= 5:", "    print('latency_median_s', round(latencies[len(latencies)//2], 4))"].join("\n")
    const tmpScript = join("/tmp", `tribunus-mlx-bench-${Date.now()}.py`)
    await (await import("node:fs/promises")).writeFile(tmpScript, code, { mode: 0o600 })
    try {
      const result = await governedRun("python3", [tmpScript], { timeout: 600_000 })
      if (!result.ok) return { content: [{ type: "text" as const, text: `Benchmark failed: ${result.stderr}` }], isError: true }
      return ok({ model_id: modelId, iterations: iters, stdout: result.stdout })
    } finally {
      await (await import("node:fs/promises")).unlink(tmpScript).catch(() => {})
    }
  })
}
