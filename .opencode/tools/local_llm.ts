import { tool } from "@opencode-ai/plugin"
import { init, fileKnowledge } from "./db"
import { existsSync } from "node:fs"

// ═══════════════════════════════════════════════════════════
// 🧠 LOCAL LLM (node-llama-cpp) — optional, degrades gracefully
// ═══════════════════════════════════════════════════════════

let llama: any = null
let modelReady = false

async function loadModel() {
  if (modelReady) return true
  try {
    const { getLlama, LlamaChatSession } = await import("node-llama-cpp")
    // Look for model in standard locations
    const paths = [
      process.env.LLAMA_MODEL_PATH,
      "./models/tinyllama-1.1b.Q4_K_M.gguf",
      "./models/model.gguf",
      process.env.HOME + "/.cache/llama/model.gguf",
    ].filter(Boolean)
    
    for (const p of paths) {
      if (p && existsSync(p)) {
        llama = await getLlama()
        const model = await llama.loadModel({ modelPath: p })
        const ctx = await model.createContext({ contextSize: 2048 })
        modelReady = true
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

async function classify(text: string, labels: string[]): Promise<string | null> {
  if (!await loadModel()) return null
  try {
    const session = new llama.LlamaChatSession({
      contextSequence: () => llama.getContext(),
      systemPrompt: `Classify the following text into exactly one of these categories: ${labels.join(", ")}. Respond with ONLY the category name, nothing else.`,
    })
    const response = await session.prompt(text.slice(0, 1000))
    for (const label of labels) {
      if (response.toLowerCase().includes(label.toLowerCase())) return label
    }
    return labels[0]!
  } catch { return null }
}

async function summarize(text: string, maxWords: number = 20): Promise<string | null> {
  if (!await loadModel()) return null
  try {
    const session = new llama.LlamaChatSession({
      contextSequence: () => llama.getContext(),
      systemPrompt: `Summarize the following text in ${maxWords} words or less. Be concise.`,
    })
    return (await session.prompt(text.slice(0, 2000))).slice(0, 200)
  } catch { return null }
}

export default tool({
  description: "Local LLM-powered analysis (node-llama-cpp). Classify agent outputs, summarize files, detect intent. Gracefully degrades if no model file is available — falls back to heuristics.",
  args: {
    action: tool.schema.string().describe("'classify' to categorize text | 'summarize' to compress text | 'status' to check if model is loaded"),
    text: tool.schema.string().optional().describe("Text to analyze."),
    labels: tool.schema.string().optional().describe("Comma-separated categories (for 'classify')."),
    max_words: tool.schema.number().optional().describe("Max words for summary (default 20)."),
  },
  async execute(args, context) {
    if (args.action === "status") {
      const ready = await loadModel()
      return JSON.stringify({
        action: "status",
        model_loaded: ready,
        hint: ready ? "Local LLM ready. Use 'classify' or 'summarize'." : "No GGUF model found. Set LLAMA_MODEL_PATH env or place model at ./models/model.gguf. Classification will fall back to heuristics.",
      }, null, 2)
    }

    if (args.action === "classify") {
      if (!args.text) return JSON.stringify({ error: "text required" }, null, 2)
      const labels = (args.labels || "").split(",").map(s => s.trim()).filter(Boolean)
      if (labels.length < 2) return JSON.stringify({ error: "At least 2 labels required" }, null, 2)

      const result = await classify(args.text, labels)
      if (result) {
        return JSON.stringify({ action: "classify", result, model: "local-llm", labels }, null, 2)
      }
      // Heuristic fallback
      const lower = args.text.toLowerCase()
      const fallback = labels.find(l => lower.includes(l.toLowerCase())) || labels[0]!
      return JSON.stringify({ action: "classify", result: fallback, model: "heuristic-fallback", labels, hint: "Local LLM unavailable. Install a GGUF model for better accuracy." }, null, 2)
    }

    if (args.action === "summarize") {
      if (!args.text) return JSON.stringify({ error: "text required" }, null, 2)
      const result = await summarize(args.text, args.max_words ?? 20)
      if (result) {
        return JSON.stringify({ action: "summarize", summary: result, model: "local-llm" }, null, 2)
      }
      // Fallback: first N words
      const words = args.text.split(/\s+/).slice(0, args.max_words ?? 20)
      return JSON.stringify({ action: "summarize", summary: words.join(" ") + "...", model: "heuristic-fallback", hint: "Local LLM unavailable." }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: classify, summarize, status.` }, null, 2)
  },
})
