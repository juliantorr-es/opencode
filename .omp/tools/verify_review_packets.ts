import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent"
import { fileURLToPath } from "node:url"
import { verifyReviewPackets } from "./_lib/review-export/verify-packets.js"
import { makeToolResponse } from "./_lib/code-intelligence/tool-response.js"

function parseCliArgs(args: string[]) {
  const input: { source_zip_path?: string; ir_zip_path?: string } = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === "--source-zip-path" && args[i + 1]) {
      input.source_zip_path = args[i + 1]
      i += 1
    }
    if (arg === "--ir-zip-path" && args[i + 1]) {
      input.ir_zip_path = args[i + 1]
      i += 1
    }
  }
  return input
}

const factory: CustomToolFactory = (pi) => ({
  name: "verify_review_packets",
  label: "Verify Review Packets",
  description: "Verify that the source-review and Gemini IR ZIPs contain the Oxc source-graph gate evidence.",
  parameters: pi.zod.object({
    source_zip_path: pi.zod.string().optional(),
    ir_zip_path: pi.zod.string().optional(),
  }),
  async execute(_toolCallId, params) {
    const result = await Promise.resolve(verifyReviewPackets(pi.cwd, params))
    return makeToolResponse("Verified review packet source-graph evidence.", result as Record<string, unknown>)
  },
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = verifyReviewPackets(process.cwd(), parseCliArgs(process.argv.slice(2)))
  console.log(JSON.stringify(result, null, 2))
}

export default factory
