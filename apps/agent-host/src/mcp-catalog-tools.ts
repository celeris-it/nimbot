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
        "Call a tool listed by list_mcp_tools with its validated arguments. Large results return resultJson, resultId and nextCursor. Use read_mcp_result to read more without calling the external tool again.",
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
    createServerTool({
      operation: "catalog-mcp.read-result",
      name: "read_mcp_result",
      description:
        "Read the next part of a large MCP result in this task. Pass its resultId and nextCursor as cursor. Concatenate the resultJson fragments in order to recover the original JSON.",
      inputSchema: {
        type: "object",
        properties: {
          resultId: { type: "string", format: "uuid" },
          cursor: { type: "integer", minimum: 1 },
        },
        required: ["resultId", "cursor"],
        additionalProperties: false,
      },
    }),
  ];
}
