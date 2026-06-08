import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent"
import { semanticReviewPacketExport } from "./_lib/code-intelligence/exports/semantic-review-packet-export.js"
import { makeToolResponse } from "./_lib/code-intelligence/tool-response.js"

function parseCliArgs(args: string[]) {
  const input: { output_path?: string; force?: boolean } = { force: true }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === "--output-path" && args[i + 1]) {
      input.output_path = args[i + 1]
      i += 1
    }
    if (arg === "--no-force") {
      input.force = false
    }
  }
  return input
}

const factory: CustomToolFactory = (pi) => ({
  name: "semantic_review_packet_export",
  label: "Semantic Review Packet Export",
  description: "Export the semantic v1 review packet for Gemini-style code review.",
  parameters: pi.zod.object({
    output_path: pi.zod.string().optional(),
    force: pi.zod.boolean().optional().default(true),
  }),
  async execute(_toolCallId, params, onUpdate) {
    const result = await semanticReviewPacketExport(pi.cwd, {
      ...params,
      progress: (event) => {
        onUpdate?.({
          content: [{ type: "text", text: event.message ?? `${event.stage}: ${event.status}` }],
          details: event as unknown as Record<string, unknown>,
        })
      },
    })
    return makeToolResponse(
      `Semantic review packet exported to ${result.zip_path}.`,
      result as Record<string, unknown>,
    )
  },
})

if (import.meta.main) {
  const result = await semanticReviewPacketExport(process.cwd(), {
    ...parseCliArgs(process.argv.slice(2)),
    progress: (event) => {
      process.stderr.write(`[${event.stage}:${event.status}] ${event.message ?? ""}\n`)
    },
  })
  console.log(JSON.stringify(result, null, 2))
}

export default factory
