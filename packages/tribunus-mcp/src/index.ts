import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js"
import * as crypto from "node:crypto"
import { readFile, mkdir } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

// ── Config ──────────────────────────────────────────────────────────────────

const APP_ID = process.env.GITHUB_APP_ID
const INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID
const PRIVATE_KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH
const GITHUB_API = "https://api.github.com"

// ── Compute Kernel Config ──────────────────────────────────────────────────

const COMPUTE_NATIVE_DIR = process.env.TRIBUNUS_COMPUTE_DIR || resolve(process.cwd(), "packages/compute-native")
const HF_API = process.env.HF_API || "https://huggingface.co/api"
const HF_TOKEN = process.env.HF_TOKEN || ""
const MACMON_URL = process.env.MACMONT_URL || "http://localhost:9090/metrics"
const EVIDENCE_DB = process.env.TRIBUNUS_EVIDENCE_DB || join(COMPUTE_NATIVE_DIR, "evidence.duckdb")
const MLX_MODEL_DIR = process.env.TRIBUNUS_MLX_MODEL_DIR || join(homedir(), ".cache/tribunus/models")

// ── Auth ────────────────────────────────────────────────────────────────────

let _cachedToken: { token: string; expiresAt: number } | null = null
let _privateKey: string | null = null

async function getPrivateKey(): Promise<string> {
  if (_privateKey) return _privateKey
  if (!PRIVATE_KEY_PATH) throw new Error("GITHUB_APP_PRIVATE_KEY_PATH is not set")
  _privateKey = await readFile(PRIVATE_KEY_PATH, "utf-8")
  return _privateKey
}

function generateJWT(privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: APP_ID }),
  ).toString("base64url")
  const signingInput = `${header}.${payload}`
  const sign = crypto.createSign("RSA-SHA256")
  sign.update(signingInput)
  sign.end()
  const signature = sign.sign(privateKey, "base64url")
  return `${signingInput}.${signature}`
}

async function getInstallationToken(): Promise<string> {
  if (_cachedToken && _cachedToken.expiresAt > Date.now() + 60_000) {
    return _cachedToken.token
  }
  if (!APP_ID) throw new Error("GITHUB_APP_ID is not set")
  if (!INSTALLATION_ID) throw new Error("GITHUB_APP_INSTALLATION_ID is not set")
  const pk = await getPrivateKey()
  const jwt = generateJWT(pk)
  const res = await fetch(
    `${GITHUB_API}/app/installations/${INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Failed to get installation token: ${res.status} ${body}`)
  }
  const data = (await res.json()) as { token: string; expires_at: string }
  _cachedToken = {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  }
  return _cachedToken.token
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function ghRequest(
  method: string,
  path: string,
  body?: unknown,
  rawBody?: string,
): Promise<{ status: number; body: unknown }> {
  const token = await getInstallationToken()
  const headers = apiHeaders(token)
  if (body !== undefined) headers["Content-Type"] = "application/json"
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers,
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  })
  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: res.status, body: parsed }
}

// ── HuggingFace HTTP ────────────────────────────────────────────────────────

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

// ── macmon HTTP ─────────────────────────────────────────────────────────────

const _macmonSessions = new Map<string, { startTime: number; interval: number; samples: MacmonMetric[][] }>()

interface MacmonMetric {
  name: string
  value: number
  labels: Record<string, string>
}

function parsePrometheusMetrics(raw: string): MacmonMetric[] {
  const metrics: MacmonMetric[] = []
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
        const [k, v] = pair.split("=").map(s => s.replace(/"/g, "").trim())
        if (k && v !== undefined) labels[k] = v
      }
      metrics.push({ name, value, labels })
    }
  }
  return metrics
}

async function macmonFetch(): Promise<MacmonMetric[]> {
  const res = await fetch(MACMON_URL)
  if (!res.ok) throw new Error(`macmon fetch failed: ${res.status} ${res.statusText}`)
  return parsePrometheusMetrics(await res.text())
}

// ── Subprocess ──────────────────────────────────────────────────────────────

interface SubprocessResult {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  ok: boolean
}

function run(
  command: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number; env?: Record<string, string> },
): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString() })
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString() })
    const timer = opts?.timeout
      ? setTimeout(() => { child.kill("SIGTERM")
        setTimeout(() => { child.kill("SIGKILL") }, 5000) }, opts.timeout)
      : null
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr, code, signal, ok: code === 0 })
    })
    child.on("error", (err) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr: err.message, code: null, signal: null, ok: false })
    })
  })
}

async function ghGet(path: string) {
  return ghRequest("GET", path)
}

async function ghPost(path: string, body?: unknown) {
  return ghRequest("POST", path, body)
}

async function ghPut(path: string, body?: unknown) {
  return ghRequest("PUT", path, body)
}

async function ghPatch(path: string, body?: unknown) {
  return ghRequest("PATCH", path, body)
}

async function ghDelete(path: string) {
  return ghRequest("DELETE", path)
}

// ── Tool definitions ────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// Governance Primitives
// ═══════════════════════════════════════════════════════════════════════════

// ── Receipt Envelope ───────────────────────────────────────────────────────

interface InvocationReceipt {
  invocation_id: string
  tool: string
  version: string
  start: string
  end: string
  duration_ms: number
  success: boolean
  timeout: boolean
  exit_code: number | null
  signal: string | null
  stdout_digest: string | null
  stderr_digest: string | null
  created_paths: string[]
  modified_paths: string[]
  output_digests: Record<string, string>
  env_policy_digest: string
  errors: string[]
}

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex")
}

function digestIfPresent(data: string): string | null {
  return data ? sha256Hex(data) : null
}

function makeReceipt(tool: string, envPolicyDigest: string): { receipt: InvocationReceipt; finalize: (result: {
  success: boolean
  timeout: boolean
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  created: string[]
  modified: string[]
  outputDigests: Record<string, string>
  errors: string[]
}) => InvocationReceipt } {
  const start = new Date().toISOString()
  const receipt: InvocationReceipt = {
    invocation_id: crypto.randomUUID(),
    tool,
    version: "0.3.0",
    start,
    end: "",
    duration_ms: 0,
    success: false,
    timeout: false,
    exit_code: null,
    signal: null,
    stdout_digest: null,
    stderr_digest: null,
    created_paths: [],
    modified_paths: [],
    output_digests: {},
    env_policy_digest: envPolicyDigest,
    errors: [],
  }
  return {
    receipt,
    finalize: (result) => {
      receipt.end = new Date().toISOString()
      receipt.duration_ms = Date.now() - new Date(start).getTime()
      receipt.success = result.success
      receipt.timeout = result.timeout
      receipt.exit_code = result.exitCode
      receipt.signal = result.signal
      receipt.stdout_digest = digestIfPresent(result.stdout)
      receipt.stderr_digest = digestIfPresent(result.stderr)
      receipt.created_paths = result.created
      receipt.modified_paths = result.modified
      receipt.output_digests = result.outputDigests
      receipt.errors = result.errors
      return receipt
    },
  }
}

// ── Path Policy ─────────────────────────────────────────────────────────────

const AUTHORIZED_ROOTS: { root: string; writable: boolean }[] = []

function initPathPolicy(worktree: string, evidenceDir: string, modelDir: string, tmpDir: string) {
  AUTHORIZED_ROOTS.length = 0
  AUTHORIZED_ROOTS.push(
    { root: resolve(worktree), writable: false },
    { root: resolve(worktree, "packages/compute-native"), writable: true },
    { root: resolve(evidenceDir), writable: true },
    { root: resolve(modelDir), writable: true },
    { root: resolve(tmpDir), writable: true },
  )
}

function validatePath(p: string, mustBeWritable: boolean): { valid: boolean; resolved: string; error?: string } {
  const resolved = resolve(p)
  const real: string = (() => { try { return realpathSync(resolved) } catch { return resolved } })()
  for (const root of AUTHORIZED_ROOTS) {
    const rootResolved = resolve(root.root)
    if (real.startsWith(rootResolved + "/") || real === rootResolved) {
      if (mustBeWritable && !root.writable) {
        return { valid: false, resolved: real, error: `path ${real} is not in a writable root` }
      }
      return { valid: true, resolved: real }
    }
  }
  return { valid: false, resolved: real, error: `path ${real} is outside authorized roots` }
}

function validateOrReject(p: string, mustBeWritable: boolean): string {
  const result = validatePath(p, mustBeWritable)
  if (!result.valid) throw new Error(result.error || "path rejected")
  return result.resolved
}

// ── Subprocess Authority ────────────────────────────────────────────────────

const SUBPROCESS_OUTPUT_LIMIT = 10 * 1024 * 1024 // 10 MiB
const ALLOWED_ENV = new Set(["PATH", "HOME", "USER", "TMPDIR", "SHELL", "LANG", "RUSTUP_HOME", "CARGO_HOME"])

function sanitizeEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ALLOWED_ENV) {
    if (process.env[key]) env[key] = process.env[key]!
  }
  return env
}

function governedRun(
  command: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<SubprocessResult> {
  const env = sanitizeEnv()
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts?.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // process group leader
    })
    let stdout = ""
    let stderr = ""
    let killed = false
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < SUBPROCESS_OUTPUT_LIMIT) stdout += d.toString()
    })
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < SUBPROCESS_OUTPUT_LIMIT) stderr += d.toString()
    })
    if (stdout.length >= SUBPROCESS_OUTPUT_LIMIT) stdout += "\n[OUTPUT TRUNCATED]"
    if (stderr.length >= SUBPROCESS_OUTPUT_LIMIT) stderr += "\n[OUTPUT TRUNCATED]"
    const killGroup = () => {
      if (killed) return
      killed = true
      try { process.kill(-child.pid!, "SIGTERM") } catch {}
      setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL") } catch {} }, 5000)
    }
    const timer = opts?.timeout ? setTimeout(killGroup, opts.timeout) : null
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer)
      const truncated = stdout.length >= SUBPROCESS_OUTPUT_LIMIT || stderr.length >= SUBPROCESS_OUTPUT_LIMIT
      resolve({
        stdout: truncated ? stdout.slice(0, SUBPROCESS_OUTPUT_LIMIT) : stdout,
        stderr: truncated ? stderr.slice(0, SUBPROCESS_OUTPUT_LIMIT) : stderr,
        code, signal, ok: code === 0,
      })
    })
    child.on("error", (err) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr: err.message, code: null, signal: null, ok: false })
    })
  })
}

// ── Capability Sets ─────────────────────────────────────────────────────────

type Capability = "github:read" | "github:write" | "compute:build" | "compute:bench" | "compute:profile" | "compute:inference" | "evidence:read" | "evidence:admin" | "model:acquire" | "hardware:monitor"

const TOOL_CAPABILITIES: Record<string, Capability[]> = {
  // GitHub
  github_api: ["github:read", "github:write"],
  create_or_update_file: ["github:write"],
  get_file_contents: ["github:read"],
  create_pull_request: ["github:write"],
  merge_pull_request: ["github:write"],
  create_issue: ["github:write"],
  list_issues: ["github:read"],
  list_workflow_runs: ["github:read"],
  trigger_workflow: ["github:write"],
  create_release: ["github:write"],
  get_pages_config: ["github:read"],
  create_pages_site: ["github:write"],
  update_pages_config: ["github:write"],
  delete_pages_site: ["github:write"],
  list_deployments: ["github:read"],
  get_deployment_status: ["github:read"],
  cancel_deployment: ["github:write"],
  get_latest_build: ["github:read"],
  list_builds: ["github:read"],
  request_build: ["github:write"],
  list_repositories: ["github:read"],
  get_repository: ["github:read"],
  compare_commits: ["github:read"],
  create_branch: ["github:write"],
  get_commit: ["github:read"],
  list_workflow_jobs: ["github:read"],
  // Compute Kernel
  hf_search_models: ["model:acquire"],
  hf_get_model_info: ["model:acquire"],
  hf_download_model: ["model:acquire"],
  macmon_metrics: ["hardware:monitor"],
  cargo_build: ["compute:build"],
  cargo_bench: ["compute:bench"],
  cargo_check: ["compute:build"],
  metal_compile: ["compute:build"],
  xctrace_record: ["compute:profile"],
  duckdb_query: ["evidence:read"],
  duckdb_list_tables: ["evidence:read"],
  mlx_inference: ["compute:inference"],
  mlx_benchmark: ["compute:bench", "compute:inference"],
}

function checkCapability(tool: string): { allowed: boolean; missing: Capability[] } {
  const required = TOOL_CAPABILITIES[tool]
  if (!required) return { allowed: true, missing: [] } // unclassified tools default to allowed
  const enabled = (process.env.TRIBUNUS_CAPABILITIES || "").split(",").map(s => s.trim()).filter(Boolean)
  if (enabled.length === 0) return { allowed: true, missing: [] } // no capability filter configured
  const missing = required.filter(c => !enabled.includes(c))
  return { allowed: missing.length === 0, missing }
}

// ═══════════════════════════════════════════════════════════════════════════

const GITHUB_TOOLS = [
  // ── Generic proxy ──
  {
    name: "github_api",
    description:
      "Call any GitHub REST API endpoint. Use this for operations not covered by specific tools. " +
      "Authentication is handled automatically via the GitHub App installation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method",
        },
        path: {
          type: "string",
          description: "API path starting with / (e.g. /repos/owner/repo/issues)",
        },
        body: {
          type: "object",
          description: "JSON request body (for POST/PUT/PATCH)",
        },
        raw_body: {
          type: "string",
          description: "Raw string body (for pushing file content as base64)",
        },
      },
      required: ["method", "path"],
    },
  },

  // ── Contents (write) ──
  {
    name: "create_or_update_file",
    description:
      "Create or update a single file in a repository. Uses the Contents API to commit directly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        path: { type: "string", description: "File path within the repo" },
        content: { type: "string", description: "File content (UTF-8)" },
        message: { type: "string", description: "Commit message" },
        branch: {
          type: "string",
          description: "Branch to commit to (default: repo default branch)",
        },
        sha: {
          type: "string",
          description: "SHA of the file to replace (required for updates, omit for new files)",
        },
      },
      required: ["owner", "repo", "path", "content", "message"],
    },
  },
  {
    name: "get_file_contents",
    description: "Get the contents of a file or directory in a repository",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        path: { type: "string", description: "File path within the repo" },
        ref: { type: "string", description: "Branch or commit SHA (default: default branch)" },
      },
      required: ["owner", "repo", "path"],
    },
  },

  // ── Pull Requests (write) ──
  {
    name: "create_pull_request",
    description: "Create a pull request",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        title: { type: "string", description: "PR title" },
        head: { type: "string", description: "Source branch name" },
        base: { type: "string", description: "Target branch name" },
        body: { type: "string", description: "PR description (markdown)" },
        draft: { type: "boolean", description: "Create as draft" },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        pull_number: { type: "number", description: "PR number" },
        merge_method: {
          type: "string",
          enum: ["merge", "squash", "rebase"],
          description: "Merge method",
        },
        commit_title: { type: "string", description: "Merge commit title" },
        commit_message: { type: "string", description: "Merge commit message" },
      },
      required: ["owner", "repo", "pull_number"],
    },
  },

  // ── Issues (write) ──
  {
    name: "create_issue",
    description: "Create a new issue in a repository",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body (markdown)" },
        labels: { type: "array", items: { type: "string" }, description: "Label names" },
        assignees: { type: "array", items: { type: "string" }, description: "Assignee usernames" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "list_issues",
    description: "List issues for a repository with optional filters",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        state: {
          type: "string",
          enum: ["open", "closed", "all"],
          description: "Issue state filter",
        },
        labels: { type: "string", description: "Comma-separated label names" },
        assignee: { type: "string", description: "Assignee username" },
        per_page: { type: "number", description: "Results per page (max 100)" },
        page: { type: "number", description: "Page number" },
      },
      required: ["owner", "repo"],
    },
  },

  // ── Actions / Workflows (write) ──
  {
    name: "list_workflow_runs",
    description: "List workflow runs for a repository",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        workflow_id: {
          type: "string",
          description: "Workflow file name or ID (optional, omit for all workflows)",
        },
        branch: { type: "string", description: "Filter by branch" },
        status: {
          type: "string",
          enum: ["completed", "action_required", "cancelled", "failure", "in_progress", "queued"],
          description: "Filter by status",
        },
        per_page: { type: "number", description: "Results per page" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "trigger_workflow",
    description: "Trigger a workflow dispatch event",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        workflow_id: {
          type: "string",
          description: "Workflow file name or ID",
        },
        ref: { type: "string", description: "Branch or tag to run on" },
        inputs: {
          type: "object",
          description: "Workflow input parameters (key-value pairs)",
        },
      },
      required: ["owner", "repo", "workflow_id", "ref"],
    },
  },

  // ── Releases (contents write) ──
  {
    name: "create_release",
    description: "Create a new release with an optional tag",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        tag_name: { type: "string", description: "Tag name (e.g. v1.0.0)" },
        name: { type: "string", description: "Release name (defaults to tag)" },
        body: { type: "string", description: "Release notes (markdown)" },
        draft: { type: "boolean", description: "Create as draft" },
        prerelease: { type: "boolean", description: "Mark as prerelease" },
        target_commitish: {
          type: "string",
          description: "Branch or commit SHA (default: default branch)",
        },
      },
      required: ["owner", "repo", "tag_name"],
    },
  },

  // ── GitHub Pages (write) ──
  {
    name: "get_pages_config",
    description: "Get the GitHub Pages configuration for a repository",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_pages_site",
    description: "Create a GitHub Pages site. Configures the source branch and path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        source_branch: {
          type: "string",
          description: "Branch to publish from (e.g. 'main', 'gh-pages')",
        },
        source_path: {
          type: "string",
          enum: ["/", "/docs"],
          description: "Path within the branch ('/' or '/docs')",
        },
      },
      required: ["owner", "repo", "source_branch"],
    },
  },
  {
    name: "update_pages_config",
    description: "Update Pages config (source, CNAME, HTTPS enforcement)",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        source_branch: {
          type: "string",
          description: "Branch to publish from",
        },
        source_path: { type: "string", enum: ["/", "/docs"] },
        cname: { type: "string", description: "Custom domain" },
        https_enforced: { type: "boolean", description: "Enforce HTTPS" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "delete_pages_site",
    description: "Delete a GitHub Pages site",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "list_deployments",
    description: "List GitHub Pages deployments (most recent first)",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        per_page: { type: "number" },
        page: { type: "number" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "get_deployment_status",
    description: "Get the status of a specific Pages deployment",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        deployment_id: { type: "number" },
      },
      required: ["owner", "repo", "deployment_id"],
    },
  },
  {
    name: "cancel_deployment",
    description: "Cancel an in-progress Pages deployment",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        deployment_id: { type: "number" },
      },
      required: ["owner", "repo", "deployment_id"],
    },
  },
  {
    name: "get_latest_build",
    description: "Get the latest Pages build for a repository",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "list_builds",
    description: "List Pages builds for a repository",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        per_page: { type: "number" },
        page: { type: "number" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "request_build",
    description: "Request a Pages build for the latest commit on the configured branch",
    inputSchema: {
      type: "object" as const,
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
      },
      required: ["owner", "repo"],
      },
    },

    // ── Repository operations (administration, metadata) ──
    {
      name: "list_repositories",
      description: "List repositories accessible to the GitHub App installation",
      inputSchema: {
        type: "object" as const,
        properties: {
         per_page: { type: "number", description: "Results per page (max 100)" },
          page: { type: "number", description: "Page number" },
        },
        required: [],
      },
    },
    {
      name: "get_repository",
      description: "Get metadata for a single repository",
      inputSchema: {
        type: "object" as const,
        properties: {
          owner: { type: "string", description: "Repository owner" },
          repo: { type: "string", description: "Repository name" },
        },
      required: ["owner", "repo"],
      },
    },

    // ── Git data (contents, refs) ──
    {
      name: "compare_commits",
      description: "Compare two commits, branches, or tags — returns the diff (files changed, commits between)",
      inputSchema: {
        type: "object" as const,
        properties: {
          owner: { type: "string", description: "Repository owner" },
          repo: { type: "string", description: "Repository name" },
          base: { type: "string", description: "Base ref (e.g. 'main', 'HEAD~5')" },
          head: { type: "string", description: "Head ref (e.g. 'feature-branch', 'HEAD')" },
        },
        required: ["owner", "repo", "base", "head"],
      },
    },
    {
      name: "create_branch",
      description: "Create a new branch from a base ref SHA",
      inputSchema: {
        type: "object" as const,
        properties: {
          owner: { type: "string", description: "Repository owner" },
          repo: { type: "string", description: "Repository name" },
          branch: { type: "string", description: "New branch name (e.g. 'feature/foo')" },
          sha: { type: "string", description: "SHA to branch from" },
        },
        required: ["owner", "repo", "branch", "sha"],
      },
    },
    {
      name: "get_commit",
      description: "Get a single commit by SHA",
      inputSchema: {
        type: "object" as const,
        properties: {
          owner: { type: "string", description: "Repository owner" },
          repo: { type: "string", description: "Repository name" },
          sha: { type: "string", description: "Commit SHA" },
        },
        required: ["owner", "repo", "sha"],
      },
    },

    // ── Workflow jobs (actions) ──
    {
      name: "list_workflow_jobs",
      description: "List jobs for a specific workflow run",
      inputSchema: {
        type: "object" as const,
        properties: {
          owner: { type: "string", description: "Repository owner" },
          repo: { type: "string", description: "Repository name" },
          run_id: { type: "number", description: "Workflow run ID" },
          per_page: { type: "number", description: "Results per page" },
        },
        required: ["owner", "repo", "run_id"],
      },
    },
  ]


// ═══════════════════════════════════════════════════════════════════════
// Compute Kernel Tools
// ═══════════════════════════════════════════════════════════════════════

const COMPUTE_TOOLS = [
  // ── HuggingFace Model Acquisition ──
  {
    name: "hf_search_models",
    description:
      "Search HuggingFace Hub for models. Returns model IDs, tags, downloads, and pipeline types.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g. 'gemma-4', 'mlx-community/Gemma')" },
        limit: { type: "number", description: "Max results (default: 10, max: 100)" },
        author: { type: "string", description: "Filter by author/org (e.g. 'google', 'mlx-community')" },
        pipeline_tag: { type: "string", description: "Filter by pipeline type (e.g. 'text-generation')" },
      },
      required: ["query"],
    },
  },
  {
    name: "hf_get_model_info",
    description:
      "Get detailed metadata for a HuggingFace model: description, tags, license, downloads, " +
      "safetensors parameters, file list with SHA-256 digests.",
    inputSchema: {
      type: "object" as const,
      properties: {
        model_id: { type: "string", description: "Full model ID (e.g. 'google/gemma-4-12b-it')" },
      },
      required: ["model_id"],
    },
  },
  {
    name: "hf_download_model",
    description:
      "Two-phase download: resolve revision, download to staging, verify hashes, atomically install. " +
      "Resolves org/model to a pinned revision, creates a manifest of authorized files, downloads into " +
      "a staging directory, recomputes local SHA-256 digests, validates safetensors headers, " +
      "records license and model-card provenance, then atomically renames into a content-addressed destination. " +
      "Returns an installation receipt with the pinned revision, file manifests, and verification results " +
      "rather than a bare path. Never treats a mutable model ID as a complete artifact identity.",
    inputSchema: {
      type: "object" as const,
      properties: {
        model_id: { type: "string", description: "Full model ID (e.g. 'google/gemma-4-12b-it')" },
        revision: { type: "string", description: "Pinned revision (branch, tag, or commit SHA). Required for claim-grade installs." },
        target_dir: { type: "string", description: "Target directory (default: TRIBUNUS_MLX_MODEL_DIR/model_id)" },
        include: { type: "string", description: "Glob for files to include (default: '*.safetensors,*.json,tokenizer*')" },
      },
      required: ["model_id"],
    },
  },

  // ── macmon Hardware Monitoring ──
  {
    name: "macmon_metrics",
    description:
      "Read real-time Apple Silicon hardware metrics: CPU/GPU/ANE power (watts), utilization (%), " +
      "memory pressure, temperature sensors, and GPU frequency. Requires macmon running locally.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filter: { type: "string", description: "Substring to filter metric names (e.g. 'gpu', 'power')" },
      },
      required: [],
    },
  },
  {
    name: "macmon_session",
    description:
      "Session-oriented hardware monitor: start, sample, stop, finalize. Binds samples to a run ID, " +
      "uses monotonic timestamps, records requested and observed sampling interval, reports dropped " +
      "or malformed samples, preserves unavailable metrics as absent rather than zero, and emits " +
      "canonical hardware-sample events suitable for alignment with benchmark intervals.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["start", "sample", "stop"], description: "Session action" },
        session_id: { type: "string", description: "Session ID (required for sample and stop)" },
        interval_ms: { type: "number", description: "Sampling interval in ms for start (default: 100)" },
      },
      required: ["action"],
    },
  },
  // ── Cargo Build & Benchmark ──
  {
    name: "cargo_build",
    description:
      "Build the Tribunus compute kernel with cargo. Supports five custom profiles: image-build, " +
      "inference-research, inference-debug, inference-evidence, inference-evidence-fat. Runs from COMPUTE_NATIVE_DIR.",
    inputSchema: {
      type: "object" as const,
      properties: {
        profile: { type: "string", description: "Cargo profile (default: image-build)" },
        features: { type: "string", description: "Comma-separated feature flags (e.g. 'metal,neon,bench')" },
        target: { type: "string", description: "Build target triple (default: aarch64-apple-darwin)" },
        release: { type: "boolean", description: "Build in release mode (sets --release)" },
      },
      required: [],
    },
  },
  {
    name: "cargo_bench",
    description:
      "Run Criterion benchmarks for the compute kernel. Returns throughput, latency, and variance.",
    inputSchema: {
      type: "object" as const,
      properties: {
        bench: { type: "string", description: "Benchmark name filter (e.g. 'decode', 'prefill')" },
        profile: { type: "string", description: "Cargo profile for benchmarks (default: inference-research)" },
        features: { type: "string", description: "Comma-separated feature flags" },
      },
      required: [],
    },
  },
  {
    name: "cargo_check",
    description:
      "Run cargo check (fast compile-check without codegen) on the compute kernel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        features: { type: "string", description: "Comma-separated feature flags" },
        profile: { type: "string", description: "Cargo profile (default: image-build)" },
      },
      required: [],
    },
  },

  // ── Metal GPU Tooling ──
  {
    name: "metal_compile",
    description:
      "Compile a Metal Shading Language (.metal) file to Apple Intermediate Representation (.air). " +
      "Runs 'xcrun -sdk macosx metal'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        source: { type: "string", description: "Path to .metal source file" },
        output: { type: "string", description: "Path for .air output (default: source with .air extension)" },
        opt: { type: "string", enum: ["none", "fast", "faster", "fastest"], description: "Optimization level (default: fastest)" },
      },
      required: ["source"],
    },
  },
  {
    name: "xctrace_record",
    description:
      "Profile a native binary with xctrace (Instruments CLI). Captures CPU, GPU, and Metal performance counters.",
    inputSchema: {
      type: "object" as const,
      properties: {
        binary: { type: "string", description: "Path to the binary to profile" },
        args: { type: "string", description: "Arguments to pass to the binary" },
        template: { type: "string", description: "Instruments template (default: 'Metal System Trace')" },
        output: { type: "string", description: "Path for .trace output (default: /tmp/tribunus-profile-{ts}.trace)" },
        time_limit: { type: "number", description: "Time limit in seconds (default: 30)" },
      },
      required: ["binary"],
    },
  },

  // ── DuckDB Evidence Analytics ──
  {
    name: "duckdb_query",
    description:
      "Run a read-only SQL query against the Tribunus evidence DuckDB database. " +
      "Accepts only single SELECT, WITH, DESCRIBE, SHOW, or EXPLAIN statements. " +
      "Opens the database in read-only mode. Enforces row, byte, and execution-time limits.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sql: { type: "string", description: "SQL query to execute" },
        db_path: { type: "string", description: "Path to DuckDB database (default: TRIBUNUS_EVIDENCE_DB)" },
        max_rows: { type: "number", description: "Maximum result rows (default: 1000)" },
        max_bytes: { type: "number", description: "Maximum result bytes (default: 1048576 = 1 MiB)" },
      },
      required: ["sql"],
    },
  },
  {
    name: "duckdb_list_tables",
    description:
      "List all tables in the Tribunus evidence DuckDB database. Row counts are approximate " +
      "(from table statistics, not full scans) and optional via include_counts parameter.",
    inputSchema: {
      type: "object" as const,
      properties: {
        db_path: { type: "string", description: "Path to DuckDB database (default: TRIBUNUS_EVIDENCE_DB)" },
        include_counts: { type: "boolean", description: "Include approximate row counts (default: false — avoids full table scans)" },
      },
      required: [],
    },
  },
  {
    name: "duckdb_admin_execute",
    description:
      "Execute administrative SQL against the evidence database. DANGER: allows DDL, DML, INSERT, UPDATE, DELETE. " +
      "Requires 'evidence:admin' capability. The evidence database should ideally be rebuilt from canonical Arrow " +
      "or Parquet artifacts rather than edited interactively.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sql: { type: "string", description: "SQL to execute (DDL, DML, INSERT, UPDATE, DELETE)" },
        db_path: { type: "string", description: "Path to DuckDB database (default: TRIBUNUS_EVIDENCE_DB)" },
      },
      required: ["sql"],
    },
  },
  // ── MLX Inference ──
  {
    name: "mlx_inference",
    description:
      "Run MLX inference on a loaded model. Uses Python mlx-lm to perform text generation. " +
      "Requires mlx and mlx-lm Python packages installed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        model_id: { type: "string", description: "HF model ID or local path (e.g. 'mlx-community/gemma-4-12b-it-4bit')" },
        prompt: { type: "string", description: "Input prompt for generation" },
        mode: { type: "string", enum: ["generate", "decode_one"], description: "'generate' for text, 'decode_one' for deterministic single-token logits (default: generate)" },
        token_ids: { type: "string", description: "Comma-separated token IDs for decode_one mode (required when mode=decode_one)" },
        max_tokens: { type: "number", description: "Maximum tokens to generate (default: 256)" },
        temperature: { type: "number", description: "Sampling temperature (default: 0.7). Set to 0 for deterministic." },
        top_p: { type: "number", description: "Nucleus sampling top-p (default: 0.95)" },
        seed: { type: "number", description: "Random seed for reproducibility" },
      },
      required: ["model_id"],
    },
  },
  {
    name: "mlx_benchmark",
    description:
      "Benchmark MLX inference: measure prefill latency, decode token/s throughput, and memory usage. " +
      "Separates model load, tokenizer load, prefill, first decode, warm decode, and cleanup phases. " +
      "Percentiles (p95, p99) are only reported when iterations >= 20; otherwise marked unavailable. " +
      "Requires minimum 5 iterations for any percentile reporting.",
    inputSchema: {
      type: "object" as const,
      properties: {
        model_id: { type: "string", description: "HF model ID or local path" },
        prompt_length: { type: "number", description: "Approximate prompt length in tokens (default: 128)" },
        max_tokens: { type: "number", description: "Tokens to generate per iteration (default: 256)" },
        iterations: { type: "number", description: "Number of benchmark iterations (default: 10, min: 5 for percentiles)" },
      },
      required: ["model_id"],
    },
  },
]

const TOOLS = [
  ...GITHUB_TOOLS,
  ...COMPUTE_TOOLS,
]

// ── Helpers ─────────────────────────────────────────────────────────────────

let _activeReceipt: {
  created: string[]
  modified: string[]
  outputDigests: Record<string, string>
  errors: string[]
  success: boolean
  timeout: boolean
  stdout: string
  stderr: string
} | null = null

function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ""
}

function ok(result: unknown) {
  if (_activeReceipt) _activeReceipt.success = true
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
}

function err(message: string) {
  if (_activeReceipt) { _activeReceipt.errors.push(message); _activeReceipt.success = false }
  return { content: [{ type: "text" as const, text: message }], isError: true }
}

function parseBody(args: Record<string, unknown> | undefined): { body: unknown; raw: string | undefined } {
  if (!args) return { body: undefined, raw: undefined }
  if (args.raw_body !== undefined) return { body: undefined, raw: args.raw_body as string }
  if (args.body !== undefined) return { body: args.body, raw: undefined }
  return { body: undefined, raw: undefined }
}

// ── Tool dispatch ───────────────────────────────────────────────────────────

const server = new Server(
  { name: "tribunus", version: "0.3.0" },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params
  const a = args as Record<string, unknown> | undefined
  const repo = a ? `${a.owner}/${a.repo}` : ""

  // Capability gate
  const cap = checkCapability(name)
  if (!cap.allowed) return err(`Capability denied: tool "${name}" requires [${cap.missing.join(", ")}]. Set TRIBUNUS_CAPABILITIES to enable.`)

  // Receipt envelope
  const envDigest = sha256Hex(Object.entries(process.env).filter(([k]) => ALLOWED_ENV.has(k)).sort().map(([k,v]) => `${k}=${v}`).join("\n"))
  const { receipt, finalize } = makeReceipt(name, envDigest)

  _activeReceipt = { created: [], modified: [], outputDigests: {}, errors: [], success: false, timeout: false, stdout: "", stderr: "" }

  try {
    switch (name) {
      // ── Generic proxy ──
      case "github_api": {
        const { body, raw } = parseBody(a)
        const path = (a?.path as string) || ""
        const result = await ghRequest(
          (a?.method as string) || "GET",
          path,
          body,
          raw,
        )
        return ok({ status: result.status, body: result.body })
      }

      // ── Contents ──
      case "create_or_update_file": {
        const content = Buffer.from((a?.content as string) || "").toString("base64")
        const fileBody: Record<string, unknown> = {
          message: a?.message,
          content,
        }
        if (a?.branch) fileBody.branch = a.branch
        if (a?.sha) fileBody.sha = a.sha
        const r = await ghPut(`/repos/${repo}/contents/${a?.path}`, fileBody)
        return ok(r)
      }

      case "get_file_contents": {
        const ref = a?.ref ? `?ref=${a.ref}` : ""
        const r = await ghGet(`/repos/${repo}/contents/${a?.path}${ref}`)
        if (r.status === 200 && typeof r.body === "object" && r.body !== null && "content" in r.body) {
          const b = r.body as Record<string, unknown>
          if (b.encoding === "base64" && typeof b.content === "string") {
            b.decoded = Buffer.from(b.content, "base64").toString("utf-8")
          }
        }
        return ok(r)
      }

      // ── Pull Requests ──
      case "create_pull_request": {
        const r = await ghPost(`/repos/${repo}/pulls`, {
          title: a?.title,
          head: a?.head,
          base: a?.base,
          body: a?.body,
          draft: a?.draft,
        })
        return ok(r)
      }

      case "merge_pull_request": {
        const body: Record<string, unknown> = {}
        if (a?.merge_method) body.merge_method = a.merge_method
        if (a?.commit_title) body.commit_title = a.commit_title
        if (a?.commit_message) body.commit_message = a.commit_message
        const r = await ghPut(`/repos/${repo}/pulls/${a?.pull_number}/merge`, body)
        return ok(r)
      }

      // ── Issues ──
      case "create_issue": {
        const r = await ghPost(`/repos/${repo}/issues`, {
          title: a?.title,
          body: a?.body,
          labels: a?.labels,
          assignees: a?.assignees,
        })
        return ok(r)
      }

      case "list_issues": {
        const params: Record<string, unknown> = {}
        if (a?.state) params.state = a.state
        if (a?.labels) params.labels = a.labels
        if (a?.assignee) params.assignee = a.assignee
        if (a?.per_page) params.per_page = a.per_page
        if (a?.page) params.page = a.page
        const r = await ghGet(`/repos/${repo}/issues${qs(params)}`)
        return ok(r)
      }

      // ── Workflows ──
      case "list_workflow_runs": {
        const params: Record<string, unknown> = {}
        if (a?.branch) params.branch = a.branch
        if (a?.status) params.status = a.status
        if (a?.per_page) params.per_page = a.per_page
        const base = a?.workflow_id
          ? `/repos/${repo}/actions/workflows/${a.workflow_id}/runs`
          : `/repos/${repo}/actions/runs`
        const r = await ghGet(`${base}${qs(params)}`)
        return ok(r)
      }

      case "trigger_workflow": {
        const r = await ghPost(
          `/repos/${repo}/actions/workflows/${a?.workflow_id}/dispatches`,
          { ref: a?.ref, inputs: a?.inputs || {} },
        )
        return ok(r)
      }

      // ── Releases ──
      case "create_release": {
        const r = await ghPost(`/repos/${repo}/releases`, {
          tag_name: a?.tag_name,
          name: a?.name || a?.tag_name,
          body: a?.body,
          draft: a?.draft,
          prerelease: a?.prerelease,
          target_commitish: a?.target_commitish,
        })
        return ok(r)
      }

      // ── Pages ──
      // ── Repository operations ──
      case "list_repositories":
        return ok(await ghGet(`/installation/repositories${qs({ per_page: a?.per_page, page: a?.page })}`))

      case "get_repository":
        return ok(await ghGet(`/repos/${repo}`))

      // ── Git data ──
      case "compare_commits":
        return ok(await ghGet(`/repos/${repo}/compare/${a?.base}...${a?.head}`))

      case "create_branch": {
        const r = await ghPost(`/repos/${repo}/git/refs`, {
          ref: `refs/heads/${a?.branch}`,
          sha: a?.sha,
        })
        return ok(r)
      }

      case "get_commit":
        return ok(await ghGet(`/repos/${repo}/commits/${a?.sha}`))

      // ── Workflow jobs ──
      case "list_workflow_jobs":
        return ok(
          await ghGet(
            `/repos/${repo}/actions/runs/${a?.run_id}/jobs${qs({ per_page: a?.per_page })}`,
          ),
        )

      // ── Pages ──
      case "get_pages_config":
        return ok(await ghGet(`/repos/${repo}/pages`))

      case "create_pages_site":
        return ok(
          await ghPost(`/repos/${repo}/pages`, {
            source: { branch: a?.source_branch, path: a?.source_path || "/" },
          }),
        )

      case "update_pages_config": {
        const update: Record<string, unknown> = {}
        if (a?.source_branch)
          update.source = { branch: a.source_branch, path: a.source_path || "/" }
        if (a?.cname !== undefined) update.cname = a.cname
        if (a?.https_enforced !== undefined) update.https_enforced = a.https_enforced
        return ok(await ghPut(`/repos/${repo}/pages`, update))
      }

      case "delete_pages_site":
        return ok(await ghDelete(`/repos/${repo}/pages`))

      case "list_deployments":
        return ok(
          await ghGet(`/repos/${repo}/pages/deployments${qs({ per_page: a?.per_page, page: a?.page })}`),
        )

      case "get_deployment_status":
        return ok(await ghGet(`/repos/${repo}/pages/deployments/${a?.deployment_id}`))

      case "cancel_deployment":
        return ok(await ghDelete(`/repos/${repo}/pages/deployments/${a?.deployment_id}`))

      case "get_latest_build":
        return ok(await ghGet(`/repos/${repo}/pages/builds/latest`))

      case "list_builds":
        return ok(
          await ghGet(`/repos/${repo}/pages/builds${qs({ per_page: a?.per_page, page: a?.page })}`),
        )

      case "request_build":
        return ok(await ghPost(`/repos/${repo}/pages/builds`))

      // ═══════════════════════════════════════════════════════════════════
      // Compute Kernel Dispatch
      // ═══════════════════════════════════════════════════════════════════

      // ── HuggingFace Model Acquisition ──
      case "hf_search_models": {
        const params: Record<string, string> = {}
        if (a?.query) params.search = String(a.query)
        if (a?.author) params.author = String(a.author)
        if (a?.pipeline_tag) params.pipeline_tag = String(a.pipeline_tag)
        if (a?.limit) params.limit = String(Math.min(Number(a.limit), 100))
        params.expand = "author,downloads,likes,pipeline_tag,safetensors"
        const r = await hfGet(`/models${qs(params as Record<string, unknown>)}`)
        return ok(r)
      }

      case "hf_get_model_info": {
        const modelId = a?.model_id as string
        const [info, files] = await Promise.all([
          hfGet(`/models/${modelId}`),
          hfGet(`/models/${modelId}?expand[]=siblings`),
        ])
        const result: Record<string, unknown> = { model_id: modelId }
        if (info.status === 200 && typeof info.body === "object" && info.body) {
          const m = info.body as Record<string, unknown>
          result.description = m.description
          result.tags = m.tags
          result.pipeline_tag = m.pipeline_tag
          result.likes = m.likes
          result.downloads = m.downloads
          result.license = m.license
          const sp = m.safetensors as Record<string, unknown> | undefined
          if (sp) result.safetensors_parameters = sp.parameters
        }
        if (files.status === 200 && typeof files.body === "object" && files.body) {
          const f = files.body as Record<string, unknown>
          const siblings = (f.siblings || []) as Array<Record<string, unknown>>
          result.files = siblings.map((s) => ({
            name: s.rfilename,
            size: s.size,
            sha256: s.blob_id ?? (s.lfs as Record<string, string | undefined> | undefined)?.["sha256"],
          }))
        }
        return ok(result)
      }

      case "hf_download_model": {
        const modelId = a?.model_id as string
        const targetDir = (a?.target_dir as string) || join(MLX_MODEL_DIR, modelId.replace("/", "_"))
        const include = (a?.include as string) || "*.safetensors,*.json,tokenizer*"
        const revision = (a?.revision as string) || ""
        // Phase 0: Resolve revision if not provided
        let pinnedRevision = revision
        if (!pinnedRevision) {
          const info = await hfGet(`/models/${modelId}`)
          if (info.status !== 200) return err(`Failed to resolve model: ${info.status}`)
          const m = info.body as Record<string, unknown>
          pinnedRevision = (m.sha || m._id || "main") as string
        }
        // Phase 1: Fetch file manifest from HF API
        const filesRes = await hfGet(`/models/${modelId}?revision=${pinnedRevision}&expand[]=siblings`)
        if (filesRes.status !== 200) return err(`Failed to fetch file list: ${filesRes.status}`)
        const f = filesRes.body as Record<string, unknown>
        const siblings = (f.siblings || []) as Array<Record<string, unknown>>
        const includePatterns = include.split(",").map(s => s.trim())
        const manifest = siblings.filter(s => {
          const name = s.rfilename as string
          return includePatterns.some(pat => {
            const re = new RegExp("^" + pat.replace(/\*/g, ".*").replace(/\?/g, ".") + "$")
            return re.test(name)
          })
        }).map(s => ({
          file: s.rfilename as string,
          size: s.size as number,
          expected_sha256: (s.blob_id || (s.lfs as Record<string, string> | undefined)?.["sha256"] || "") as string,
        }))
        if (manifest.length === 0) return err(`No files matched include pattern "${include}" at revision ${pinnedRevision}`)
        // Phase 2: Download to staging directory
        const staging = join(targetDir, `.staging-${Date.now()}`)
        await mkdir(staging, { recursive: true })
        const downloadArgs = [
          "huggingface-cli", "download", modelId,
          "--revision", pinnedRevision,
          "--local-dir", staging,
          "--include", include,
        ]
        const dlResult = await governedRun("bun", ["x", ...downloadArgs], { timeout: 600_000 })
        if (!dlResult.ok) return err(`Download failed (exit ${dlResult.code}):\n${dlResult.stderr}`)
        // Phase 3: Verify local hashes
        const verification: Array<{ file: string; expected: string; actual: string; ok: boolean }> = []
        const { readFile: rf, readdir: rd } = await import("node:fs/promises")
        const stagedFiles = await rd(staging, { recursive: true })
        for (const entry of manifest) {
          const localPath = join(staging, entry.file)
          let actual = ""
          let ok = false
          try {
            const data = await rf(localPath)
            actual = crypto.createHash("sha256").update(data).digest("hex")
            ok = !entry.expected_sha256 || actual === entry.expected_sha256
          } catch { actual = "MISSING" }
          verification.push({ file: entry.file, expected: entry.expected_sha256, actual, ok })
        }
        const allOk = verification.every(v => v.ok)
        if (!allOk) {
          const failed = verification.filter(v => !v.ok).map(v => `${v.file}: expected=${v.expected} actual=${v.actual}`)
          return err(`Hash verification failed for ${failed.length}/${verification.length} files:\n${failed.join("\n")}`)
        }
        // Phase 4: Validate safetensors headers (structural check only — no tensor materialization)
        const safetensorsFiles = manifest.filter(e => e.file.endsWith(".safetensors"))
        for (const sf of safetensorsFiles) {
          const localPath = join(staging, sf.file)
          try {
            const header = await rf(localPath, { encoding: null })
            const headerLen = header.readBigUInt64LE(0)
            if (headerLen === 0n) return err(`Invalid safetensors header in ${sf.file}: zero header length`)
            const headerJson = JSON.parse(header.subarray(8, 8 + Number(headerLen)).toString("utf-8"))
            if (!headerJson || typeof headerJson !== "object") return err(`Invalid safetensors header in ${sf.file}: not JSON object`)
          } catch (e) {
            return err(`Safetensors validation failed for ${sf.file}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        // Phase 5: Capture provenance (model card, license)
        let provenance: Record<string, unknown> = {}
        try {
          const cardRes = await hfGet(`/models/${modelId}?revision=${pinnedRevision}`)
          if (cardRes.status === 200) {
            const cm = cardRes.body as Record<string, unknown>
            provenance = {
              model_id: modelId,
              revision: pinnedRevision,
              license: cm.license,
              pipeline_tag: cm.pipeline_tag,
              tags: cm.tags,
              author: cm.author,
              sha: cm.sha,
            }
          }
        } catch { /* provenance is best-effort */ }
        // Phase 6: Atomic install — rename staging into target
        const finalDir = join(targetDir, `${modelId.replace("/", "_")}-${pinnedRevision.slice(0, 12)}`)
        const { rename: fsRename } = await import("node:fs/promises")
        try { await fsRename(staging, finalDir) } catch {
          return err(`Failed to atomically rename staging to ${finalDir}`)
        }
        return ok({
          model_id: modelId,
          pinned_revision: pinnedRevision,
          install_dir: finalDir,
          file_count: manifest.length,
          manifest,
          verification: { all_ok: allOk, results: verification },
          safetensors_validated: safetensorsFiles.length,
          provenance,
          download_stderr: dlResult.stderr,
        })
      }

      // ── macmon Hardware Monitoring ──
      case "macmon_metrics": {
        const filter = (a?.filter as string) || ""
        const metrics = await macmonFetch()
        const filtered = filter
          ? metrics.filter((m) => m.name.toLowerCase().includes(filter.toLowerCase()))
          : metrics
        const summary: Record<string, number> = {}
        for (const m of filtered) {
          const key = Object.keys(m.labels).length > 0
            ? `${m.name}{${Object.entries(m.labels).map(([k, v]) => `${k}=${v}`).join(",")}}`
            : m.name
          summary[key] = m.value
        }
        return ok({ count: filtered.length, metrics: summary, raw: filtered })
      }

      case "macmon_session": {
        const action = a?.action as string
        if (action === "start") {
          const sid = crypto.randomUUID()
          const interval = (a?.interval_ms as number) || 100
          _macmonSessions.set(sid, { startTime: Date.now(), interval, samples: [] })
          // Start background sampling
          const doSample = async () => {
            const session = _macmonSessions.get(sid)
            if (!session) return
            try {
              const metrics = await macmonFetch()
              session.samples.push(metrics)
            } catch { /* drop malformed samples, record as absent on finalize */ }
            if (_macmonSessions.has(sid)) setTimeout(doSample, interval)
          }
          setTimeout(doSample, interval)
          return ok({ action: "start", session_id: sid, interval_ms: interval, started_at: new Date().toISOString() })
        }
        const sid = a?.session_id as string
        if (!sid || !_macmonSessions.has(sid)) return err(`Session "${sid}" not found. Use action=start first.`)
        const session = _macmonSessions.get(sid)!
        if (action === "sample") {
          try {
            const metrics = await macmonFetch()
            session.samples.push(metrics)
            return ok({ action: "sample", session_id: sid, sample_index: session.samples.length - 1, timestamp: new Date().toISOString() })
          } catch (e) {
            return err(`Sample failed: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        if (action === "stop") {
          _macmonSessions.delete(sid)
          const durationMs = Date.now() - session.startTime
          const expectedSamples = Math.floor(durationMs / session.interval)
          const actualSamples = session.samples.length
          const dropped = expectedSamples - actualSamples
          // Aggregate: last sample for each metric (most recent reading)
          const lastSample = session.samples[session.samples.length - 1] || []
          const summary: Record<string, number> = {}
          for (const m of lastSample) {
            const key = Object.keys(m.labels).length > 0
              ? `${m.name}{${Object.entries(m.labels).map(([k, v]) => `${k}=${v}`).join(",")}}`
              : m.name
            summary[key] = m.value
          }
          return ok({
            action: "stop", session_id: sid,
            duration_ms: durationMs,
            expected_samples: expectedSamples,
            actual_samples: actualSamples,
            dropped_samples: dropped > 0 ? dropped : 0,
            interval_ms: session.interval,
            final_metrics: summary,
          })
        }
        return err(`Unknown action: ${action}`)
      }

      // ── Cargo Build & Benchmark ──
      case "cargo_build": {
        const profile = (a?.profile as string) || "image-build"
        const features = (a?.features as string) || ""
        const target = (a?.target as string) || ""
        const release = a?.release === true
        // Check dirty tree
        const gitStatus = await governedRun("git", ["status", "--porcelain"], { cwd: COMPUTE_NATIVE_DIR, timeout: 10_000 })
        const isDirty = gitStatus.ok && gitStatus.stdout.trim().length > 0
        if (isDirty && !process.env.TRIBUNUS_ALLOW_DIRTY_BUILD) {
          return err(`Working tree is dirty. Set TRIBUNUS_ALLOW_DIRTY_BUILD=1 to override.\n${gitStatus.stdout.slice(0, 500)}`)
        }
        // Collect build metadata
        const [commitRes, lockDigest, rustcRes] = await Promise.all([
          governedRun("git", ["rev-parse", "HEAD"], { cwd: COMPUTE_NATIVE_DIR, timeout: 5_000 }),
          (async () => { try { const data = await readFile(resolve(COMPUTE_NATIVE_DIR, "Cargo.lock")); return sha256Hex(data.toString()) } catch { return "MISSING" } })(),
          governedRun("rustc", ["--version"], { timeout: 5_000 }),
        ])
        const commit = commitRes.ok ? commitRes.stdout.trim() : "UNKNOWN"
        const rustcVersion = rustcRes.ok ? rustcRes.stdout.trim() : "UNKNOWN"
        const args = ["build"]
        if (release) args.push("--release")
        else if (profile) args.push("--profile", profile)
        if (features) args.push("--features", features)
        if (target) args.push("--target", target)
        const result = await governedRun("cargo", args, { cwd: COMPUTE_NATIVE_DIR, timeout: 600_000 })
        if (!result.ok) return err(`cargo build failed (exit ${result.code}):\n${result.stderr}`)
        return ok({
          exit_code: result.code,
          commit, dirty: isDirty, rustc_version: rustcVersion,
          cargo_lock_digest: lockDigest, profile,
          features: features || "default", target: target || "aarch64-apple-darwin",
          stdout: result.stdout, stderr: result.stderr,
        })
      }

      case "cargo_bench": {
        const bench = (a?.bench as string) || ""
        const profile = (a?.profile as string) || "inference-research"
        const features = (a?.features as string) || ""
        const args = ["bench"]
        if (profile) args.push("--profile", profile)
        if (features) args.push("--features", features)
        if (bench) args.push("--bench", bench)
        const result = await run("cargo", args, { cwd: COMPUTE_NATIVE_DIR, timeout: 600_000 })
        if (!result.ok) return err(`cargo bench failed (exit ${result.code}):\n${result.stderr}`)
        return ok({ exit_code: result.code, stdout: result.stdout, stderr: result.stderr })
      }

      case "cargo_check": {
        const features = (a?.features as string) || ""
        const profile = (a?.profile as string) || "image-build"
        const args = ["check"]
        if (profile) args.push("--profile", profile)
        if (features) args.push("--features", features)
        const result = await run("cargo", args, { cwd: COMPUTE_NATIVE_DIR, timeout: 300_000 })
        if (!result.ok) return err(`cargo check failed (exit ${result.code}):\n${result.stderr}`)
        return ok({ exit_code: result.code, stderr: result.stderr })
      }

      // ── Metal GPU Tooling ──
      case "metal_compile": {
        const source = validateOrReject(String(a?.source), false)
        const airOut = validateOrReject((a?.output as string) || source.replace(/\.metal$/, ".air"), true)
        const optFlag = (a?.opt as string) || "fastest"
        // Capture source digest and SDK identity
        const sourceData = await readFile(source)
        const sourceDigest = sha256Hex(sourceData.toString())
        const sdkRes = await governedRun("xcrun", ["--show-sdk-version", "--sdk", "macosx"], { timeout: 10_000 })
        const metalRes = await governedRun("xcrun", ["--find", "metal"], { timeout: 10_000 })
        const sdkVersion = sdkRes.ok ? sdkRes.stdout.trim() : "UNKNOWN"
        const metalPath = metalRes.ok ? metalRes.stdout.trim() : "UNKNOWN"
        const args = ["-sdk", "macosx", "metal", "-O" + optFlag, "-c", source, "-o", airOut,
          "-mmacosx-version-min=14.0", "-arch", "arm64"]
        const result = await governedRun("xcrun", args, { timeout: 60_000 })
        if (!result.ok) return err(`metal compile failed:\n${result.stderr}`)
        // Compute output digest
        let outputDigest = ""
        try { const outData = await readFile(airOut); outputDigest = sha256Hex(outData.toString()) } catch {}
        return ok({
          source, source_digest: sourceDigest, output: airOut, output_digest: outputDigest,
          optimization: optFlag, sdk_version: sdkVersion, metal_path: metalPath,
          target_arch: "arm64", flags: args.slice(3).join(" "),
          stderr: result.stderr,
        })
      }

      case "xctrace_record": {
        const binary = validateOrReject(String(a?.binary), false)
        const binArgs = (a?.args as string) || ""
        const template = (a?.template as string) || "Metal System Trace"
        const timeLimit = String((a?.time_limit as number) || 30) + "s"
        const timestamp = Date.now()
        // Output MUST be within evidence directory
        const evidenceDir = join(COMPUTE_NATIVE_DIR, "evidence", "traces")
        await mkdir(evidenceDir, { recursive: true })
        const output = validateOrReject(
          (a?.output as string) || join(evidenceDir, `tribunus-profile-${timestamp}.trace`),
          true,
        )
        // Size budget: refuse traces > 500 MiB
        const MAX_TRACE_BYTES = 500 * 1024 * 1024
        const args = [
          "xctrace", "record",
          "--template", template,
          "--time-limit", timeLimit,
          "--output", output,
          "--target-stdout", "-",
          "--limit-output-size-mb", "500",
          "--launch", "--", binary,
          ...(binArgs ? binArgs.split(" ") : []),
        ]
        const result = await governedRun("xcrun", args, { timeout: (Number(a?.time_limit || 30) + 30) * 1000 })
        // Validate trace bundle exists and is non-empty
        let traceValid = false
        try {
          const traceStat = await import("node:fs/promises").then(m => m.stat(output))
          traceValid = traceStat.isDirectory() && traceStat.size > 0
        } catch {}
        if (!result.ok) return err(`xctrace failed (exit ${result.code}):\n${result.stderr}`)
        if (!traceValid) return err(`xctrace completed but trace bundle at ${output} is missing or empty`)
        // Check size budget
        let traceSize = 0
        try { traceSize = (await import("node:fs/promises").then(m => m.stat(output))).size } catch {}
        return ok({
          binary, output, template, time_limit: timeLimit,
          trace_valid: traceValid, trace_size_bytes: traceSize,
          within_budget: traceSize <= MAX_TRACE_BYTES,
          stderr: result.stderr,
        })
      }

      // ── DuckDB Evidence Analytics ──
      case "duckdb_query": {
        const sql = a?.sql as string
        const dbPath = (a?.db_path as string) || EVIDENCE_DB
        const maxRows = (a?.max_rows as number) || 1000
        const maxBytes = (a?.max_bytes as number) || 1048576
        // Reject non-read-only statements
        const trimmed = sql.trim().toUpperCase()
        const allowed = trimmed.startsWith("SELECT") || trimmed.startsWith("WITH")
          || trimmed.startsWith("DESCRIBE") || trimmed.startsWith("SHOW") || trimmed.startsWith("EXPLAIN")
          || trimmed.startsWith("PRAGMA")
        if (!allowed) return err("duckdb_query is read-only. Use duckdb_admin_execute for DDL/DML.")
        try {
          const db = await import("duckdb")
          const conn = new db.Database(dbPath)
          const result = conn.all(`${sql} LIMIT ${maxRows}`)
          const rows = result as unknown as unknown[]
          conn.close()
          const serialized = JSON.stringify(rows)
          if (serialized.length > maxBytes) {
            return err(`Result exceeds ${maxBytes} byte limit (${serialized.length} bytes). Increase max_bytes or narrow query.`)
          }
          return ok({ query: sql, rows, row_count: rows.length, byte_count: serialized.length, truncated: rows.length >= maxRows })
        } catch (e) {
          if (e instanceof Error && e.message.includes("Cannot find module")) {
            return err("duckdb npm package not installed. Run: npm install duckdb")
          }
          return err(e instanceof Error ? e.message : String(e))
        }
      }

      case "duckdb_list_tables": {
        const dbPath = (a?.db_path as string) || EVIDENCE_DB
        const includeCounts = a?.include_counts === true
        try {
          const db = await import("duckdb")
          const conn = new db.Database(dbPath)
          const sql = includeCounts
            ? "SELECT table_name, estimated_visible_rows as row_count FROM duckdb_tables() ORDER BY table_name"
            : "SELECT table_name FROM duckdb_tables() ORDER BY table_name"
          const tables = conn.all(sql)
          conn.close()
          const rows = tables as unknown as unknown[]
          return ok({ database: dbPath, tables: rows, table_count: rows.length, counts_included: includeCounts })
        } catch (e) {
          if (e instanceof Error && e.message.includes("Cannot find module")) {
            return err("duckdb npm package not installed. Run: npm install duckdb")
          }
          return err(e instanceof Error ? e.message : String(e))
        }
      }

      case "duckdb_admin_execute": {
        const sql = a?.sql as string
        const dbPath = (a?.db_path as string) || EVIDENCE_DB
        try {
          const db = await import("duckdb")
          const conn = new db.Database(dbPath)
          conn.run(sql)
          conn.close()
          return ok({ sql, message: "Executed successfully" })
        } catch (e) {
          if (e instanceof Error && e.message.includes("Cannot find module")) {
            return err("duckdb npm package not installed. Run: npm install duckdb")
          }
          return err(e instanceof Error ? e.message : String(e))
        }
      }

      // ── MLX Inference ──
      case "mlx_inference": {
        const modelId = a?.model_id as string
        const mode = (a?.mode as string) || "generate"
        const prompt = (a?.prompt as string) || ""
        const tokenIds = (a?.token_ids as string) || ""
        const maxTokens = String(a?.max_tokens || 256)
        const temp = String(a?.temperature ?? 0.7)
        const topP = String(a?.top_p ?? 0.95)
        const [pyVerRes, mlxVerRes] = await Promise.all([
          governedRun("python3", ["--version"], { timeout: 5_000 }),
          governedRun("python3", ["-c", "import mlx; print(mlx.__version__)"], { timeout: 10_000 }),
        ])
        let mlxLmVer = ""
        try { const r = await governedRun("python3", ["-c", "import mlx_lm; print(mlx_lm.__version__)"], { timeout: 10_000 }); mlxLmVer = r.ok ? r.stdout.trim() : "UNKNOWN" } catch {}
        const lines: string[] = []
        if (a?.seed) lines.push(`import random; random.seed(${a.seed})`)
        if (mode === "decode_one") {
          if (!tokenIds) return err("token_ids required for decode_one mode")
          lines.push(
            "from mlx_lm import load", "import mlx.core as mx",
            `model, tokenizer = load("${modelId}")`,
            `ids = mx.array([${tokenIds}])`,
            "logits = model(ids)",
            "last_logits = logits[0, -1, :]",
            "top_k = mx.argpartition(-last_logits, 10)[:10]",
            "top_probs = mx.softmax(last_logits[top_k])",
            "for i in range(len(top_k)):",
            "    token = tokenizer.decode([top_k[i].item()])",
            "    print(f'{top_k[i].item()}\\t{top_probs[i].item():.6f}\\t{repr(token)}')",
            "next_token = mx.argmax(last_logits).item()",
            "print(f'SELECTED: {next_token}')",
          )
        } else {
          if (!prompt) return err("prompt required for generate mode")
          lines.push(
            "from mlx_lm import load, generate",
            `model, tokenizer = load("${modelId}")`,
            `response = generate(model, tokenizer, prompt="${prompt.replace(/"/g, '\\"')}", max_tokens=${maxTokens}, temp=${temp}, top_p=${topP})`,
            "print(response)",
          )
        }
        const scriptText = lines.join("\n")
        const tmpDir = join("/tmp", `tribunus-mlx-${Date.now()}`)
        const { mkdir: mkd, writeFile: wf, unlink: ul, rmdir: rd } = await import("node:fs/promises")
        await mkd(tmpDir, { recursive: true })
        const tmpScript = join(tmpDir, "inference.py")
        await wf(tmpScript, scriptText, { mode: 0o600 })
        try {
          const result = await governedRun("python3", [tmpScript], { timeout: 300_000 })
          if (!result.ok) return err(`MLX ${mode} failed (exit ${result.code}):\n${result.stderr}`)
          return ok({
            model_id: modelId, mode,
            prompt: mode === "generate" ? prompt : undefined,
            token_ids: mode === "decode_one" ? tokenIds : undefined,
            response: result.stdout.trim(),
            python_version: pyVerRes.ok ? pyVerRes.stdout.trim() : "UNKNOWN",
            mlx_version: mlxVerRes.ok ? mlxVerRes.stdout.trim() : "UNKNOWN",
            mlx_lm_version: mlxLmVer,
            script_digest: sha256Hex(scriptText),
            stderr: result.stderr,
          })
        } finally {
          await ul(tmpScript).catch(() => {})
          await rd(tmpDir).catch(() => {})
        }
      }

      case "mlx_benchmark": {
        const modelId = a?.model_id as string
        const promptLen = String(a?.prompt_length || 128)
        const maxTokens = String(a?.max_tokens || 256)
        const iters = Math.max(Number(a?.iterations || 10), 3)
        const code = [
          "from mlx_lm import load, generate",
          "import time",
          "t_load_start = time.perf_counter()",
          `model, tokenizer = load("${modelId}")`,
          "t_load_end = time.perf_counter()",
          `prompt = "Benchmark test. " * ${promptLen}`,
          "t_encode_start = time.perf_counter()",
          "print('prompt_length', len(tokenizer.encode(prompt)))",
          "t_encode_end = time.perf_counter()",
          "# Warm-up decode (discarded)",
          "_ = generate(model, tokenizer, prompt=prompt, max_tokens=16)",
          "print('model_id', '${modelId}'.split('/')[-1])",
          `print('iterations', ${iters})`,
          "latencies = []",
          "prefill_latencies = []",
          "first_decode_latencies = []",
          `for i in range(${iters}):`,
          "    t0 = time.perf_counter()",
          `    response = generate(model, tokenizer, prompt=prompt, max_tokens=${maxTokens})`,
          "    dt = time.perf_counter() - t0",
          "    tokens = len(tokenizer.encode(response))",
          "    latencies.append(dt)",
          "    print(f'iter_{i}_latency_s', round(dt, 4))",
          "    print(f'iter_{i}_tokens', tokens)",
          "    print(f'iter_{i}_tokens_per_sec', round(tokens / dt, 1))",
          "print('load_time_s', round(t_load_end - t_load_start, 4))",
          "print('encode_time_s', round(t_encode_end - t_encode_start, 4))",
          "latencies.sort()",
          `if len(latencies) >= 5:`,
          "    print('latency_median_s', round(latencies[len(latencies)//2], 4))",
          `if len(latencies) >= 20:`,
          "    p95_idx = int(len(latencies) * 0.95)",
          "    p99_idx = int(len(latencies) * 0.99)",
          "    print('latency_p95_s', round(latencies[min(p95_idx, len(latencies)-1)], 4))",
          "    print('latency_p99_s', round(latencies[min(p99_idx, len(latencies)-1)], 4))",
          "else:",
          "    print('latency_p95_s', 'UNAVAILABLE')",
          "    print('latency_p99_s', 'UNAVAILABLE')",
          `print('total_tokens', ${maxTokens} * ${iters})`,
        ].join("\n")
        const tmpScript = join("/tmp", `tribunus-mlx-bench-${Date.now()}.py`)
        const { writeFile, unlink } = await import("node:fs/promises")
        await writeFile(tmpScript, code)
        try {
          const result = await governedRun("python3", [tmpScript], { timeout: 600_000 })
          if (!result.ok) return err(`MLX benchmark failed (exit ${result.code}):\n${result.stderr}`)
          return ok({
            model_id: modelId,
            iterations: iters,
            percentiles_available: iters >= 5,
            percentiles_high_confidence: iters >= 20,
            stdout: result.stdout,
            stderr: result.stderr,
          })
        } finally {
          await unlink(tmpScript).catch(() => {})
        }
      }

      default:
        return err(`Unknown tool: ${name}`)
    }
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error))
  }
  finally {
    process.stderr.write(JSON.stringify(finalize({
      success: _activeReceipt?.success ?? false,
      timeout: _activeReceipt?.timeout ?? false,
      exitCode: _activeReceipt?.success ? 0 : 1,
      signal: null,
      stdout: _activeReceipt?.stdout ?? "",
      stderr: _activeReceipt?.stderr ?? "",
      created: _activeReceipt?.created ?? [],
      modified: _activeReceipt?.modified ?? [],
      outputDigests: _activeReceipt?.outputDigests ?? {},
      errors: _activeReceipt?.errors ?? [],
    })) + "\n")
    _activeReceipt = null
  }
})

const transport = new StdioServerTransport()
initPathPolicy(
  process.cwd(),
  join(process.cwd(), "packages/compute-native/evidence"),
  MLX_MODEL_DIR,
  join(process.cwd(), ".omp/evidence"),
)
await server.connect(transport)
