import { tool } from "@opencode-ai/plugin"
import { Octokit } from "octokit"

let octokit: Octokit | null = null

function getOctokit(): Octokit | null {
  if (octokit) return octokit
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (!token) return null
  octokit = new Octokit({ auth: token })
  return octokit
}

function parseRepo(): { owner: string; repo: string } | null {
  // Try to parse from git remote
  try {
    const { execSync } = require("node:child_process")
    const remote = execSync("git remote get-url origin", { encoding: "utf8" }).trim()
    const match = remote.match(/github\\.com[:/]([^/]+)\\/([^.]+)(?:\\.git)?$/)
    if (match) return { owner: match[1]!, repo: match[2]! }
  } catch {}
  return null
}

export default tool({
  description: "GitHub integration via Octokit. Create PRs, comment on issues, add labels, search code. Requires GITHUB_TOKEN env var.",
  args: {
    action: tool.schema.string().describe("'pr' to create PR | 'comment' to add comment | 'label' to add label | 'search' to search code | 'status' to check connection"),
    title: tool.schema.string().optional().describe("PR title."),
    body: tool.schema.string().optional().describe("PR body (markdown)."),
    head: tool.schema.string().optional().describe("Head branch."),
    base: tool.schema.string().optional().describe("Base branch (default 'dev')."),
    issue_number: tool.schema.number().optional().describe("Issue/PR number."),
    comment: tool.schema.string().optional().describe("Comment body."),
    labels: tool.schema.string().optional().describe("Comma-separated labels."),
    query: tool.schema.string().optional().describe("Code search query."),
    owner: tool.schema.string().optional().describe("Repo owner."),
    repo: tool.schema.string().optional().describe("Repo name."),
  },
  async execute(args, context) {
    const gh = getOctokit()
    if (!gh) return JSON.stringify({ error: "GITHUB_TOKEN not set. Export GITHUB_TOKEN env var." }, null, 2)

    const repoInfo = parseRepo()
    const owner = args.owner || repoInfo?.owner || ""
    const repo = args.repo || repoInfo?.repo || ""
    if (!owner || !repo) return JSON.stringify({ error: "Could not detect repo. Pass owner and repo args." }, null, 2)

    if (args.action === "status") {
      try {
        const { data } = await gh.rest.users.getAuthenticated()
        return JSON.stringify({ action: "status", user: data.login, repo: `${owner}/${repo}` }, null, 2)
      } catch (e: any) { return JSON.stringify({ error: e.message }, null, 2) }
    }

    if (args.action === "pr") {
      if (!args.title || !args.head) return JSON.stringify({ error: "title and head required" }, null, 2)
      try {
        const { data } = await gh.rest.pulls.create({
          owner, repo, title: args.title, body: args.body || "",
          head: args.head, base: args.base || "dev",
        })
        return JSON.stringify({
          action: "pr", status: "created", number: data.number,
          url: data.html_url, title: data.title,
          hint: "PR created. Use 'comment' to add notes, 'label' to categorize.",
        }, null, 2)
      } catch (e: any) { return JSON.stringify({ error: e.message }, null, 2) }
    }

    if (args.action === "comment") {
      if (!args.issue_number || !args.comment) return JSON.stringify({ error: "issue_number and comment required" }, null, 2)
      try {
        const { data } = await gh.rest.issues.createComment({
          owner, repo, issue_number: args.issue_number, body: args.comment,
        })
        return JSON.stringify({ action: "comment", status: "posted", url: data.html_url }, null, 2)
      } catch (e: any) { return JSON.stringify({ error: e.message }, null, 2) }
    }

    if (args.action === "label") {
      if (!args.issue_number || !args.labels) return JSON.stringify({ error: "issue_number and labels required" }, null, 2)
      try {
        await gh.rest.issues.addLabels({
          owner, repo, issue_number: args.issue_number,
          labels: args.labels.split(",").map(l => l.trim()),
        })
        return JSON.stringify({ action: "label", status: "added", labels: args.labels }, null, 2)
      } catch (e: any) { return JSON.stringify({ error: e.message }, null, 2) }
    }

    if (args.action === "search") {
      if (!args.query) return JSON.stringify({ error: "query required" }, null, 2)
      try {
        const { data } = await gh.rest.search.code({
          q: `repo:${owner}/${repo} ${args.query}`,
          per_page: 10,
        })
        return JSON.stringify({
          action: "search", query: args.query, total: data.total_count,
          results: data.items.map(i => ({ path: i.path, repo: i.repository.full_name, url: i.html_url })),
        }, null, 2)
      } catch (e: any) { return JSON.stringify({ error: e.message }, null, 2) }
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: pr, comment, label, search, status.` }, null, 2)
  },
})
