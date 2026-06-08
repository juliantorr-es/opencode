import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js"
import * as crypto from "node:crypto"
import { readFile } from "node:fs/promises"

// ── Config ──────────────────────────────────────────────────────────────────

const APP_ID = process.env.GITHUB_APP_ID
const INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID
const PRIVATE_KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH
const GITHUB_API = "https://api.github.com"

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

const TOOLS = [
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
  { name: "tribunus-github", version: "0.1.0" },
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

      default:
        return err(`Unknown tool: ${name}`)
    }
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error))
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
