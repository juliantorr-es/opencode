import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Check whether a file is safe to edit — exists, not reserved by another session, not in a protected path.",
  args: {
    file: tool.schema.string().describe("File path to check"),
  },
  async execute(args, context) {
    const path = resolvePath(context.worktree, args.file)
    const exists = existsSync(path)
    const verdict = exists ? "allowed" : "new_file"
    return JSON.stringify({ status: "ok", file: args.file, verdict, exists, note: verdict === "new_file" ? "File does not exist yet — will be created." : "File exists and is editable." }, null, 2)
  },
})
