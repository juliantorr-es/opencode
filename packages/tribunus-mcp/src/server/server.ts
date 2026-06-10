import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { listTools } from "./registry.js"
import { dispatchToolCall } from "./dispatch.js"

export function createServer(): Server {
  const server = new Server(
    { name: "tribunus", version: "0.4.0" },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = listTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
    return { tools }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), 600_000)
    try {
      return (await dispatchToolCall(request, ac.signal)) as any
    } finally {
      clearTimeout(timeout)
    }
  })

  return server
}

export async function startServer(server: Server): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
