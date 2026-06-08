import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent"
import { reviewPacketExport } from "./_lib/code-intelligence/exports/review-packet-export.js"
import { makeToolResponse } from "./_lib/code-intelligence/tool-response.js"

function parseCliArgs(args: string[]) {
  const input: { semantic_output_path?: string; source_output_path?: string; force?: boolean } = { force: true }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === "--semantic-output-path" && args[i + 1]) {
      input.semantic_output_path = args[i + 1]
      i += 1
    }
    if (arg === "--source-output-path" && args[i + 1]) {
      input.source_output_path = args[i + 1]
      i += 1
    }
    if (arg === "--no-force") {
      input.force = false
    }
  }
  return input
}

const factory: CustomToolFactory = (pi) => ({
  name: "review_packet_export",
  label: "Review Packet Export",
  description: "Export paired semantic and source review packets from the same OMP semantic snapshot.",
  parameters: pi.zod.object({
    semantic_output_path: pi.zod.string().optional(),
    source_output_path: pi.zod.string().optional(),
    force: pi.zod.boolean().optional().default(true),
  }),
  async execute(_toolCallId, params, onUpdate) {
    const result = await reviewPacketExport(pi.cwd, {
      ...params,
      progress: (event) => {
        onUpdate?.({
          content: [{ type: "text", text: event.message ?? `${event.stage}: ${event.status}` }],
          details: event as unknown as Record<string, unknown>,
        })
      },
    })
    return makeToolResponse(
      `Exported paired review packets to ${result.semantic_zip_path} and ${result.source_zip_path}.`,
      result as Record<string, unknown>,
    )
  },
})

if (import.meta.main) {
  const result = await reviewPacketExport(process.cwd(), {
    ...parseCliArgs(process.argv.slice(2)),
    progress: (event) => {
      process.stderr.write(`[${event.stage}:${event.status}] ${event.message ?? ""}\n`)
    },
  })
  console.log(JSON.stringify(result, null, 2))
}

export default factory
