import { tool } from "@opencode-ai/plugin"
import { init, searchEverything } from "./db"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

let embedder: any = null
let embedderReady = false

async function loadEmbedder() {
  if (embedderReady) return true
  try {
    const { pipeline } = await import("@xenova/transformers")
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
    embedderReady = true
    return true
  } catch { return false }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export default tool({
  description: "Semantic search using embeddings (@xenova/transformers). Find conceptually similar code, errors, or documentation — not just keyword matches. Falls back to FTS5 if embeddings unavailable.",
  args: {
    action: tool.schema.string().describe("'search' for semantic search | 'embed' to get embedding vector | 'similar' to find similar items"),
    query: tool.schema.string().optional().describe("Natural language query."),
    text: tool.schema.string().optional().describe("Text to embed."),
    limit: tool.schema.number().optional().describe("Max results (default 10)."),
  },
  async execute(args, context) {
    const db = init(context.worktree)

    if (args.action === "embed") {
      if (!args.text) return JSON.stringify({ error: "text required" }, null, 2)
      if (!await loadEmbedder()) return JSON.stringify({ error: "Embedder not available. Models downloading on first use." }, null, 2)
      const result = await embedder(args.text, { pooling: "mean", normalize: true })
      const vec = Array.from(result.data)
      return JSON.stringify({ action: "embed", dimensions: vec.length, vector_preview: vec.slice(0, 10) }, null, 2)
    }

    if (args.action === "search") {
      if (!args.query) return JSON.stringify({ error: "query required" }, null, 2)
      const limit = args.limit ?? 10

      // Try semantic search first
      if (await loadEmbedder()) {
        const queryVec = await embedder(args.query, { pooling: "mean", normalize: true })
        const queryArr = Array.from(queryVec.data)

        // Get all journal entries + file purposes
        const docs = db.query(`SELECT source, content FROM search_idx LIMIT 500`).all() as any[]
        const scored = []
        for (const doc of docs) {
          const docVec = await embedder(doc.content.slice(0, 1000), { pooling: "mean", normalize: true })
          const sim = cosineSimilarity(queryArr, Array.from(docVec.data))
          scored.push({ ...doc, score: Math.round(sim * 100) })
        }
        scored.sort((a, b) => b.score - a.score)
        return JSON.stringify({
          action: "search", query: args.query, model: "embeddings",
          results: scored.slice(0, limit).map(r => ({
            source: r.source, score: r.score,
            snippet: (r.content || "").slice(0, 200),
          })),
        }, null, 2)
      }

      // Fall back to FTS5
      const ftsResults = searchEverything(db, args.query, limit)
      return JSON.stringify({
        action: "search", query: args.query, model: "fts5-fallback",
        results: ftsResults.map((r: any) => ({ source: r.source, snippet: (r.content || "").slice(0, 200) })),
        hint: "Semantic search unavailable (models downloading). Using keyword search.",
      }, null, 2)
    }

    if (args.action === "similar") {
      if (!args.text) return JSON.stringify({ error: "text required" }, null, 2)
      if (!await loadEmbedder()) return JSON.stringify({ error: "Embedder not available." }, null, 2)
      
      const queryVec = await embedder(args.text, { pooling: "mean", normalize: true })
      const queryArr = Array.from(queryVec.data)
      const docs = db.query(`SELECT source, content FROM search_idx LIMIT 200`).all() as any[]
      const scored = []
      for (const doc of docs) {
        const docVec = await embedder(doc.content.slice(0, 1000), { pooling: "mean", normalize: true })
        scored.push({ ...doc, score: Math.round(cosineSimilarity(queryArr, Array.from(docVec.data)) * 100) })
      }
      scored.sort((a, b) => b.score - a.score)
      return JSON.stringify({
        action: "similar", results: scored.slice(0, 10).filter(r => r.score > 40).map(r => ({
          source: r.source, score: r.score, snippet: (r.content || "").slice(0, 200),
        })),
      }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: search, embed, similar.` }, null, 2)
  },
})
