import { createServerTool } from "./server-tool.js";

export function createMcpCatalogToolDefinitions() {
  return [
    createServerTool({
      operation: "catalog-mcp.list",
      name: "list_mcp_tools",
      description:
        "Find external tools enabled in the Nimbot MCP catalog. Search by integration or tool name. Pass a returned tool ID to retrieve its argument schema, then use call_mcp_tool.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 128 },
          cursor: { type: "integer", minimum: 0 },
          toolId: { type: "string" },
        },
        additionalProperties: false,
      },
    }),
    createServerTool({
      operation: "catalog-mcp.call",
      name: "call_mcp_tool",
      description:
        "Call a tool listed by list_mcp_tools with its validated arguments.",
      inputSchema: {
        type: "object",
        properties: {
          toolId: { type: "string" },
          arguments: { type: "object", additionalProperties: true },
        },
        required: ["toolId", "arguments"],
        additionalProperties: false,
      },
    }),
  ];
}
