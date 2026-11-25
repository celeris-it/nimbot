import { createHash } from "node:crypto";
import type {
  McpCatalog,
  McpCatalogTool,
  McpLocalCommand,
} from "./mcp-catalog.js";
import type { RemoteToolDefinition } from "../tasks/task-capabilities.js";
import { compileMcpArguments } from "./mcp-arguments.js";

interface SelectedTool {
  descriptor: RemoteToolDefinition;
  definitionId: string;
  label: string;
  revision: number;
  endpoint: string;
  local?: McpLocalCommand;
  tool: McpCatalogTool;
}

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Leave room in the 32-operation lease for four memory and five peer operations.
const MAX_TOOLS = 23;
const MAX_METADATA_BYTES = 16_384;

/**
 * Select only administrator-pinned tools from integrations available to the agent.
 * This is the shared lookup for capability metadata and future execution handlers;
 * endpoint and credential bindings must never be attached to Host submissions.
 */
export function createMcpToolSelection(catalog: McpCatalog) {
  function select(agentId: string, individual = false): SelectedTool[] {
    const selected: SelectedTool[] = [];
    const descriptors: RemoteToolDefinition[] = [];
    // Stable ordering prevents label edits from changing the bounded selection.
    for (const { definition, scope } of catalog.availableForAgent(agentId)) {
      const definitionId = definition.id;
      for (const tool of definition.tools) {
        if (
          tool.enabled === false ||
          definition.blockedTools?.includes(tool.name)
        )
          continue;
        if (!compileMcpArguments(tool.inputSchema)) continue;
        const descriptor: RemoteToolDefinition = {
          operation: `mcp.${hash({
            agentId,
            definitionId,
            revision: definition.revision,
            scope,
            tool: tool.name,
          })}`,
          // Reserve space for the engine's MCP server prefix in provider tool names.
          name: `mcp_${hash([definitionId, tool.name]).slice(0, 24)}_${tool.name
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, "_")
            .slice(0, 27)}`,
          inputSchema: tool.inputSchema,
        };
        if (
          individual &&
          Buffer.byteLength(JSON.stringify([...descriptors, descriptor])) >
            MAX_METADATA_BYTES
        )
          continue;
        if (individual) descriptors.push(descriptor);
        selected.push({
          descriptor,
          definitionId,
          label: definition.label,
          revision: definition.revision,
          endpoint: definition.endpoint,
          local: definition.local,
          tool,
        });
        if (individual && selected.length === MAX_TOOLS) return selected;
      }
    }
    return selected;
  }

  return {
    descriptors(agentId: string): RemoteToolDefinition[] {
      return select(agentId, true).map(({ descriptor }) => descriptor);
    },
    available(agentId: string) {
      return select(agentId);
    },
    /** Re-read all authority; a stale or model-invented operation resolves to nothing. */
    resolve(agentId: string, operation: string): SelectedTool | undefined {
      return select(agentId).find(
        ({ descriptor }) => descriptor.operation === operation,
      );
    },
    /** Validate against the current pinned schema without coercion or defaults. */
    validate(
      agentId: string,
      operation: string,
      input: unknown,
    ): Record<string, unknown> | undefined {
      const selected = select(agentId).find(
        ({ descriptor }) => descriptor.operation === operation,
      );
      return (
        selected && compileMcpArguments(selected.tool.inputSchema)?.(input)
      );
    },
  };
}
