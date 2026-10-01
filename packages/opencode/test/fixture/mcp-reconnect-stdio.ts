import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

// A stdio MCP server whose `crash` tool kills the process, used to exercise reconnects.
// `MCP_RECONNECT_FAIL_FILE`, when that file exists, makes the server exit before speaking MCP.
const failFile = process.env.MCP_RECONNECT_FAIL_FILE
if (failFile && (await Bun.file(failFile).exists())) process.exit(1)

const server = new Server({ name: "mcp-reconnect-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [
      { name: "pid", inputSchema: { type: "object", properties: {} } },
      { name: "crash", inputSchema: { type: "object", properties: {} } },
    ],
  }),
)

server.setRequestHandler(CallToolRequestSchema, (request) => {
  if (request.params.name === "crash") process.exit(0)
  return Promise.resolve({ content: [{ type: "text", text: String(process.pid) }] })
})

await server.connect(new StdioServerTransport())
