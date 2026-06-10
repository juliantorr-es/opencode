import { registerTool } from "../../server/registry.js"
import type { Capability } from "../../governance/capabilities.js"
import * as crypto from "node:crypto"
import { readFile } from "node:fs/promises"

const APP_ID = process.env.GITHUB_APP_ID
const INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID
const PRIVATE_KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH
const GITHUB_API = "https://api.github.com"

let _cachedToken: { token: string; expiresAt: number } | null = null
let _privateKey: string | null = null

async function getPrivateKey(): Promise<string> {
  if (_privateKey) return _privateKey
  if (!PRIVATE_KEY_PATH) throw new Error("GITHUB_APP_PRIVATE_KEY_PATH not set")
  _privateKey = await readFile(PRIVATE_KEY_PATH, "utf-8")
  return _privateKey
}

function generateJWT(pk: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: APP_ID })).toString("base64url")
  const signingInput = `${header}.${payload}`
  const sign = crypto.createSign("RSA-SHA256")
  sign.update(signingInput); sign.end()
  return `${signingInput}.${sign.sign(pk, "base64url")}`
}

async function getInstallationToken(): Promise<string> {
  if (_cachedToken && _cachedToken.expiresAt > Date.now() + 60_000) return _cachedToken.token
  if (!APP_ID) throw new Error("GITHUB_APP_ID not set")
  if (!INSTALLATION_ID) throw new Error("GITHUB_APP_INSTALLATION_ID not set")
  const pk = await getPrivateKey()
  const jwt = generateJWT(pk)
  const res = await fetch(`${GITHUB_API}/app/installations/${INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  })
  if (!res.ok) throw new Error(`Failed to get installation token: ${res.status}`)
  const data = await res.json() as { token: string; expires_at: string }
  _cachedToken = { token: data.token, expiresAt: new Date(data.expires_at).getTime() }
  return _cachedToken.token
}

function apiHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
}

async function ghRequest(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const token = await getInstallationToken()
  const headers = apiHeaders(token)
  if (body !== undefined) headers["Content-Type"] = "application/json"
  const res = await fetch(`${GITHUB_API}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch {}
  return { status: res.status, body: parsed }
}

function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) { if (v !== undefined && v !== null) p.set(k, String(v)) }
  const s = p.toString()
  return s ? `?${s}` : ""
}

function ok(result: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] } }

function t(name: string, desc: string, props: Record<string, unknown>, req: string[], caps: Capability[], ms: number, fn: (a: Record<string, unknown>) => Promise<unknown>) {
  registerTool({ name, description: desc, inputSchema: { type: "object", properties: props as any, required: req }, requiredCapabilities: caps, timeoutMs: ms, execute: (_ctx, input) => fn(input) })
}

export function registerGitHubTools(): void {
  t("github_api", "Call any GitHub REST API endpoint.", {
    method: { type: "string", enum: ["GET","POST","PUT","PATCH","DELETE"] },
    path: { type: "string" },
    body: { type: "object" },
  }, ["method","path"], ["github:read","github:write"], 30_000, async (a) => {
    const r = await ghRequest((a.method as string)||"GET", (a.path as string)||"", a.body)
    return ok({ status: r.status, body: r.body })
  })

  t("create_or_update_file", "Create or update a file in a repo.", {
    owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" },
    content: { type: "string" }, message: { type: "string" },
    branch: { type: "string" }, sha: { type: "string" },
  }, ["owner","repo","path","content","message"], ["github:write"], 30_000, async (a) => {
    const repo = `${a.owner}/${a.repo}`
    const body: Record<string, unknown> = { message: a.message, content: Buffer.from(String(a.content)).toString("base64") }
    if (a.branch) body.branch = a.branch
    if (a.sha) body.sha = a.sha
    return ok(await ghRequest("PUT", `/repos/${repo}/contents/${a.path}`, body))
  })

  t("get_file_contents", "Get file contents from a repo.", {
    owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" }, ref: { type: "string" },
  }, ["owner","repo","path"], ["github:read"], 30_000, async (a) => {
    const repo = `${a.owner}/${a.repo}`
    const ref = a.ref ? `?ref=${a.ref}` : ""
    const r = await ghRequest("GET", `/repos/${repo}/contents/${a.path}${ref}`)
    if (r.status === 200 && typeof r.body === "object" && r.body && "content" in r.body) {
      const b = r.body as Record<string, unknown>
      if (b.encoding === "base64" && typeof b.content === "string") b.decoded = Buffer.from(b.content, "base64").toString("utf-8")
    }
    return ok(r)
  })

  t("create_pull_request", "Create a PR.", {
    owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" },
    head: { type: "string" }, base: { type: "string" }, body: { type: "string" }, draft: { type: "boolean" },
  }, ["owner","repo","title","head","base"], ["github:write"], 30_000, async (a) => {
    return ok(await ghRequest("POST", `/repos/${a.owner}/${a.repo}/pulls`, { title: a.title, head: a.head, base: a.base, body: a.body, draft: a.draft }))
  })

  t("merge_pull_request", "Merge a PR.", {
    owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "number" },
    merge_method: { type: "string", enum: ["merge","squash","rebase"] },
  }, ["owner","repo","pull_number"], ["github:write"], 30_000, async (a) => {
    const body: Record<string, unknown> = {}
    if (a.merge_method) body.merge_method = a.merge_method
    return ok(await ghRequest("PUT", `/repos/${a.owner}/${a.repo}/pulls/${a.pull_number}/merge`, body))
  })

  t("create_issue", "Create an issue.", {
    owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" },
    body: { type: "string" }, labels: { type: "array", items: { type: "string" } }, assignees: { type: "array", items: { type: "string" } },
  }, ["owner","repo","title"], ["github:write"], 30_000, async (a) => {
    return ok(await ghRequest("POST", `/repos/${a.owner}/${a.repo}/issues`, { title: a.title, body: a.body, labels: a.labels, assignees: a.assignees }))
  })

  t("list_issues", "List repo issues.", {
    owner: { type: "string" }, repo: { type: "string" }, state: { type: "string", enum: ["open","closed","all"] },
    labels: { type: "string" }, assignee: { type: "string" }, per_page: { type: "number" }, page: { type: "number" },
  }, ["owner","repo"], ["github:read"], 30_000, async (a) => {
    const params: Record<string, unknown> = {}
    if (a.state) params.state = a.state; if (a.labels) params.labels = a.labels
    if (a.assignee) params.assignee = a.assignee; if (a.per_page) params.per_page = a.per_page; if (a.page) params.page = a.page
    return ok(await ghRequest("GET", `/repos/${a.owner}/${a.repo}/issues${qs(params)}`))
  })

  t("list_workflow_runs", "List workflow runs.", {
    owner: { type: "string" }, repo: { type: "string" }, workflow_id: { type: "string" },
    branch: { type: "string" }, status: { type: "string" }, per_page: { type: "number" },
  }, ["owner","repo"], ["github:read"], 30_000, async (a) => {
    const params: Record<string, unknown> = {}
    if (a.branch) params.branch = a.branch; if (a.status) params.status = a.status; if (a.per_page) params.per_page = a.per_page
    const base = a.workflow_id ? `/repos/${a.owner}/${a.repo}/actions/workflows/${a.workflow_id}/runs` : `/repos/${a.owner}/${a.repo}/actions/runs`
    return ok(await ghRequest("GET", `${base}${qs(params)}`))
  })

  t("trigger_workflow", "Trigger a workflow.", {
    owner: { type: "string" }, repo: { type: "string" }, workflow_id: { type: "string" }, ref: { type: "string" },
  }, ["owner","repo","workflow_id","ref"], ["github:write"], 30_000, async (a) => {
    return ok(await ghRequest("POST", `/repos/${a.owner}/${a.repo}/actions/workflows/${a.workflow_id}/dispatches`, { ref: a.ref, inputs: {} }))
  })

  t("create_release", "Create a release.", {
    owner: { type: "string" }, repo: { type: "string" }, tag_name: { type: "string" },
    name: { type: "string" }, body: { type: "string" }, draft: { type: "boolean" }, prerelease: { type: "boolean" },
  }, ["owner","repo","tag_name"], ["github:write"], 30_000, async (a) => {
    return ok(await ghRequest("POST", `/repos/${a.owner}/${a.repo}/releases`, { tag_name: a.tag_name, name: a.name, body: a.body, draft: a.draft, prerelease: a.prerelease }))
  })

  // Pages tools
  const pagesTools: Array<[string,string,Record<string,unknown>,string[],Capability[],number,(a: Record<string,unknown>) => Promise<unknown>]> = [
    ["get_pages_config", "Get Pages config.", { owner:{type:"string"}, repo:{type:"string"} }, ["owner","repo"], ["github:read"], 30_000, async (a) => ok(await ghRequest("GET", `/repos/${a.owner}/${a.repo}/pages`))],
    ["create_pages_site", "Create Pages site.", { owner:{type:"string"}, repo:{type:"string"}, source_branch:{type:"string"}, source_path:{type:"string",enum:["/","/docs"]} }, ["owner","repo","source_branch"], ["github:write"], 30_000, async (a) => ok(await ghRequest("POST", `/repos/${a.owner}/${a.repo}/pages`, { source: { branch: a.source_branch, path: a.source_path||"/" } }))],
    ["update_pages_config", "Update Pages config.", { owner:{type:"string"}, repo:{type:"string"}, source_branch:{type:"string"}, source_path:{type:"string",enum:["/","/docs"]}, cname:{type:"string"}, https_enforced:{type:"boolean"} }, ["owner","repo"], ["github:write"], 30_000, async (a) => { const u: Record<string,unknown> = {}; if (a.source_branch) u.source = { branch: a.source_branch, path: a.source_path||"/" }; if (a.cname!==undefined) u.cname = a.cname; if (a.https_enforced!==undefined) u.https_enforced = a.https_enforced; return ok(await ghRequest("PUT", `/repos/${a.owner}/${a.repo}/pages`, u)) }],
    ["delete_pages_site", "Delete Pages site.", { owner:{type:"string"}, repo:{type:"string"} }, ["owner","repo"], ["github:write"], 30_000, async (a) => ok(await ghRequest("DELETE", `/repos/${a.owner}/${a.repo}/pages`))],
    ["list_deployments", "List Pages deployments.", { owner:{type:"string"}, repo:{type:"string"}, per_page:{type:"number"}, page:{type:"number"} }, ["owner","repo"], ["github:read"], 30_000, async (a) => ok(await ghRequest("GET", `/repos/${a.owner}/${a.repo}/pages/deployments${qs({per_page:a.per_page,page:a.page})}`))],
    ["get_deployment_status", "Get deployment status.", { owner:{type:"string"}, repo:{type:"string"}, deployment_id:{type:"number"} }, ["owner","repo","deployment_id"], ["github:read"], 30_000, async (a) => ok(await ghRequest("GET", `/repos/${a.owner}/${a.repo}/pages/deployments/${a.deployment_id}`))],
    ["cancel_deployment", "Cancel deployment.", { owner:{type:"string"}, repo:{type:"string"}, deployment_id:{type:"number"} }, ["owner","repo","deployment_id"], ["github:write"], 30_000, async (a) => ok(await ghRequest("DELETE", `/repos/${a.owner}/${a.repo}/pages/deployments/${a.deployment_id}`))],
    ["get_latest_build", "Get latest Pages build.", { owner:{type:"string"}, repo:{type:"string"} }, ["owner","repo"], ["github:read"], 30_000, async (a) => ok(await ghRequest("GET", `/repos/${a.owner}/${a.repo}/pages/builds/latest`))],
    ["list_builds", "List Pages builds.", { owner:{type:"string"}, repo:{type:"string"}, per_page:{type:"number"}, page:{type:"number"} }, ["owner","repo"], ["github:read"], 30_000, async (a) => ok(await ghRequest("GET", `/repos/${a.owner}/${a.repo}/pages/builds${qs({per_page:a.per_page,page:a.page})}`))],
    ["request_build", "Request a Pages build.", { owner:{type:"string"}, repo:{type:"string"} }, ["owner","repo"], ["github:write"], 30_000, async (a) => ok(await ghRequest("POST", `/repos/${a.owner}/${a.repo}/pages/builds`))],
  ]
  for (const [name, desc, props, req, caps, ms, fn] of pagesTools) t(name, desc, props, req, caps, ms, fn)

  // Repo + git tools
  t("list_repositories", "List accessible repos.", { per_page:{type:"number"}, page:{type:"number"} }, [], ["github:read"], 30_000, async (a) => ok(await ghRequest("GET", `/installation/repositories${qs({per_page:a.per_page,page:a.page})}`)))
  t("get_repository", "Get repo metadata.", { owner:{type:"string"}, repo:{type:"string"} }, ["owner","repo"], ["github:read"], 30_000, async (a) => ok(await ghRequest("GET", `/repos/${a.owner}/${a.repo}`)))
  t("compare_commits", "Compare two commits.", { owner:{type:"string"}, repo:{type:"string"}, base:{type:"string"}, head:{type:"string"} }, ["owner","repo","base","head"], ["github:read"], 30_000, async (a) => ok(await ghRequest("GET", `/repos/${a.owner}/${a.repo}/compare/${a.base}...${a.head}`)))
  t("create_branch", "Create a branch.", { owner:{type:"string"}, repo:{type:"string"}, branch:{type:"string"}, sha:{type:"string"} }, ["owner","repo","branch","sha"], ["github:write"], 30_000, async (a) => ok(await ghRequest("POST", `/repos/${a.owner}/${a.repo}/git/refs`, { ref: `refs/heads/${a.branch}`, sha: a.sha })))
  t("get_commit", "Get a commit.", { owner:{type:"string"}, repo:{type:"string"}, sha:{type:"string"} }, ["owner","repo","sha"], ["github:read"], 30_000, async (a) => ok(await ghRequest("GET", `/repos/${a.owner}/${a.repo}/commits/${a.sha}`)))
  t("list_workflow_jobs", "List workflow jobs.", { owner:{type:"string"}, repo:{type:"string"}, run_id:{type:"number"}, per_page:{type:"number"} }, ["owner","repo","run_id"], ["github:read"], 30_000, async (a) => ok(await ghRequest("GET", `/repos/${a.owner}/${a.repo}/actions/runs/${a.run_id}/jobs${qs({per_page:a.per_page})}`)))
}
