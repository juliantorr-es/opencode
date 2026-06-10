import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js"
import * as crypto from "node:crypto"
import { readFile, mkdir } from "node:fs/promises"
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
      "Download safetensors and config files for a HuggingFace model to the local MLX model cache. " +
      "Uses huggingface-cli. Skips files already present.",
    inputSchema: {
      type: "object" as const,
      properties: {
        model_id: { type: "string", description: "Full model ID (e.g. 'google/gemma-4-12b-it')" },
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
      "Run a SQL query against the Tribunus evidence DuckDB database. Contains benchmark results, " +
      "optimization records, inference traces, and experiment metadata.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sql: { type: "string", description: "SQL query to execute" },
        db_path: { type: "string", description: "Path to DuckDB database (default: TRIBUNUS_EVIDENCE_DB)" },
      },
      required: ["sql"],
    },
  },
  {
    name: "duckdb_list_tables",
    description:
      "List all tables in the Tribunus evidence DuckDB database with row counts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        db_path: { type: "string", description: "Path to DuckDB database (default: TRIBUNUS_EVIDENCE_DB)" },
      },
      required: [],
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
        max_tokens: { type: "number", description: "Maximum tokens to generate (default: 256)" },
        temperature: { type: "number", description: "Sampling temperature (default: 0.7)" },
        top_p: { type: "number", description: "Nucleus sampling top-p (default: 0.95)" },
        seed: { type: "number", description: "Random seed for reproducibility" },
      },
      required: ["model_id", "prompt"],
    },
  },
  {
    name: "mlx_benchmark",
    description:
      "Benchmark MLX inference: measure prefill latency, decode token/s throughput, and memory usage. " +
      "Runs multiple iterations and returns aggregated stats (median, p95, p99).",
    inputSchema: {
      type: "object" as const,
      properties: {
        model_id: { type: "string", description: "HF model ID or local path" },
        prompt_length: { type: "number", description: "Approximate prompt length in tokens (default: 128)" },
        max_tokens: { type: "number", description: "Tokens to generate per iteration (default: 256)" },
        iterations: { type: "number", description: "Number of benchmark iterations (default: 3)" },
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

function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ""
}

function ok(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
}

function err(message: string) {
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
  { name: "tribunus", version: "0.2.0" },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params
  const a = args as Record<string, unknown> | undefined
  const repo = a ? `${a.owner}/${a.repo}` : ""

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
        await mkdir(targetDir, { recursive: true })
        const args = ["huggingface-cli", "download", modelId, "--local-dir", targetDir, "--include", include]
        const result = await run("bun", ["x", ...args], { timeout: 600_000 })
        if (!result.ok) return err(`Download failed (exit ${result.code}):\n${result.stderr}`)
        return ok({ model_id: modelId, target_dir: targetDir, message: "Download complete", stderr: result.stderr })
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

      // ── Cargo Build & Benchmark ──
      case "cargo_build": {
        const profile = (a?.profile as string) || "image-build"
        const features = (a?.features as string) || ""
        const target = (a?.target as string) || ""
        const release = a?.release === true
        const args = ["build"]
        if (release) args.push("--release")
        else if (profile) args.push("--profile", profile)
        if (features) args.push("--features", features)
        if (target) args.push("--target", target)
        const result = await run("cargo", args, { cwd: COMPUTE_NATIVE_DIR, timeout: 600_000 })
        if (!result.ok) return err(`cargo build failed (exit ${result.code}):\n${result.stderr}`)
        return ok({ exit_code: result.code, stdout: result.stdout, stderr: result.stderr })
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
        const source = resolve(String(a?.source))
        const airOut = (a?.output as string) || source.replace(/\.metal$/, ".air")
        const optFlag = (a?.opt as string) || "fastest"
        const args = ["-sdk", "macosx", "metal", "-O" + optFlag, "-c", source, "-o", airOut]
        const result = await run("xcrun", args, { timeout: 60_000 })
        if (!result.ok) return err(`metal compile failed:\n${result.stderr}`)
        return ok({ source, output: airOut, optimization: optFlag, stderr: result.stderr })
      }

      case "xctrace_record": {
        const binary = resolve(String(a?.binary))
        const binArgs = (a?.args as string) || ""
        const template = (a?.template as string) || "Metal System Trace"
        const timeLimit = String((a?.time_limit as number) || 30) + "s"
        const timestamp = Date.now()
        const output = (a?.output as string) || `/tmp/tribunus-profile-${timestamp}.trace`
        const args = [
          "xctrace", "record",
          "--template", template,
          "--time-limit", timeLimit,
          "--output", output,
          "--target-stdout", "-",
          "--launch", "--", binary,
          ...(binArgs ? binArgs.split(" ") : []),
        ]
        const result = await run("xcrun", args, { timeout: (Number(a?.time_limit || 30) + 15) * 1000 })
        if (!result.ok) return err(`xctrace failed (exit ${result.code}):\n${result.stderr}`)
        return ok({ binary, output, template, time_limit: timeLimit, stderr: result.stderr })
      }

      // ── DuckDB Evidence Analytics ──
      case "duckdb_query": {
        const sql = a?.sql as string
        const dbPath = (a?.db_path as string) || EVIDENCE_DB
        try {
          const db = await import("duckdb")
          const conn = new db.Database(dbPath)
          const result = conn.all(sql)
          conn.close()
          const rows = result as unknown as unknown[]
          return ok({ query: sql, rows, row_count: rows.length })
        } catch (e) {
          if (e instanceof Error && e.message.includes("Cannot find module")) {
            return err("duckdb npm package not installed. Run: npm install duckdb")
          }
          return err(e instanceof Error ? e.message : String(e))
        }
      }

      case "duckdb_list_tables": {
        const dbPath = (a?.db_path as string) || EVIDENCE_DB
        try {
          const db = await import("duckdb")
          const conn = new db.Database(dbPath)
          const tables = conn.all(
            "SELECT table_name, estimated_visible_rows as row_count FROM duckdb_tables() ORDER BY table_name",
          )
          conn.close()
          const rows = tables as unknown as unknown[]
          return ok({ database: dbPath, tables: rows, table_count: rows.length })
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
        const prompt = a?.prompt as string
        const maxTokens = String(a?.max_tokens || 256)
        const temp = String(a?.temperature ?? 0.7)
        const topP = String(a?.top_p ?? 0.95)
        const code = [
          "from mlx_lm import load, generate",
          `model, tokenizer = load("${modelId}")`,
          `response = generate(model, tokenizer, prompt="${prompt.replace(/"/g, '\\"')}", max_tokens=${maxTokens}, temp=${temp}, top_p=${topP})`,
          "print(response)",
        ]
        if (a?.seed) code.unshift(`import random; random.seed(${a.seed})`)
        const scriptText = code.join("\n")
        const tmpScript = join("/tmp", `tribunus-mlx-inference-${Date.now()}.py`)
        const { writeFile, unlink } = await import("node:fs/promises")
        await writeFile(tmpScript, code)
        await writeFile(tmpScript, scriptText)
        try {
          const result = await run("python3", [tmpScript], { timeout: 300_000 })
          if (!result.ok) return err(`MLX inference failed (exit ${result.code}):\n${result.stderr}`)
          return ok({ model_id: modelId, prompt, response: result.stdout.trim(), stderr: result.stderr })
        } finally {
          await unlink(tmpScript).catch(() => {})
        }
      }

      case "mlx_benchmark": {
        const modelId = a?.model_id as string
        const promptLen = String(a?.prompt_length || 128)
        const maxTokens = String(a?.max_tokens || 256)
        const iters = String(a?.iterations || 3)
        const code = [
          "from mlx_lm import load, generate",
          "import time",
          `model, tokenizer = load("${modelId}")`,
          `prompt = "Benchmark test. " * ${promptLen}`,
          "print('model_id', '${modelId}'.split('/')[-1])",
          "print('iterations', ${iters})",
          "print('prompt_length', len(tokenizer.encode(prompt)))",
          "latencies = []",
          `for i in range(${iters}):`,
          "    t0 = time.perf_counter()",
          `    response = generate(model, tokenizer, prompt=prompt, max_tokens=${maxTokens})`,
          "    dt = time.perf_counter() - t0",
          "    tokens = len(tokenizer.encode(response))",
          "    latencies.append(dt)",
          "    print(f'iter_{i}_latency_s', round(dt, 4))",
          "    print(f'iter_{i}_tokens', tokens)",
          "    print(f'iter_{i}_tokens_per_sec', round(tokens / dt, 1))",
          "latencies.sort()",
          "print('latency_median_s', round(latencies[len(latencies)//2], 4))",
          `print('total_tokens', ${maxTokens} * ${iters})`,
        ].join("\n")
        const tmpScript = join("/tmp", `tribunus-mlx-bench-${Date.now()}.py`)
        const { writeFile, unlink } = await import("node:fs/promises")
        await writeFile(tmpScript, code)
        try {
          const result = await run("python3", [tmpScript], { timeout: 600_000 })
          if (!result.ok) return err(`MLX benchmark failed (exit ${result.code}):\n${result.stderr}`)
          return ok({ model_id: modelId, stdout: result.stdout, stderr: result.stderr })
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
})

const transport = new StdioServerTransport()
await server.connect(transport)
