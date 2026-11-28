import type { McpDefinitionSettings } from "../../server/src/mcp/mcp-catalog.js";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseMcpJsonc(source: string): [string, unknown][] {
  if (source.length > 65_536) throw new Error("MCP JSONC is too large");
  // Match strings first so escapes, URLs, and comment-like text remain literal.
  const withoutComments = source.replace(
    /"(?:[^"\\]|\\[\s\S])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (token) => (token.startsWith("/") ? " " : token),
  );
  const value: unknown = JSON.parse(
    withoutComments.replace(/"(?:[^"\\]|\\[\s\S])*"|,(?=\s*[}\]])/g, (token) =>
      token === "," ? "" : token,
    ),
  );
  if (!record(value)) throw new Error("Expected a named MCP server");
  const servers = record(value.mcp)
    ? value.mcp.servers
    : value.mcpServers !== undefined
      ? value.mcpServers
      : value;
  if (!record(servers) || !Object.keys(servers).length)
    throw new Error("No named MCP servers");
  return Object.entries(servers);
}

export function mcpDraft(label: string, value: unknown): McpDefinitionSettings {
  if (
    !record(value) ||
    (value.disabled !== undefined && typeof value.disabled !== "boolean")
  )
    throw new Error("Invalid MCP server");
  let entry: Record<string, unknown> = value;
  const base = { label, enabled: entry.disabled !== true, tools: [] };
  if (entry.type === undefined || entry.type === "stdio") {
    if (
      Object.keys(entry).some(
        (key) =>
          !["type", "command", "args", "env", "cwd", "disabled"].includes(key),
      ) ||
      (entry.command !== "npx" && entry.command !== "uvx") ||
      !Array.isArray(entry.args) ||
      !entry.args.every((arg) => typeof arg === "string")
    )
      throw new Error("Unsupported local MCP settings");
    entry = {
      type: "local",
      command: [entry.command, ...entry.args],
      environment: entry.env,
      cwd: entry.cwd,
      disabled: entry.disabled,
    };
  }
  if (entry.type === "local") {
    if (
      Object.keys(entry).some(
        (key) =>
          !["type", "command", "environment", "cwd", "disabled"].includes(key),
      ) ||
      (entry.cwd !== undefined && entry.cwd !== ".") ||
      !Array.isArray(entry.command) ||
      entry.command.length < 2 ||
      (entry.command[0] !== "npx" && entry.command[0] !== "uvx") ||
      !entry.command.every((arg) => typeof arg === "string") ||
      (entry.environment !== undefined &&
        (!record(entry.environment) ||
          Object.values(entry.environment).some(
            (value) =>
              typeof value !== "string" || /\{(?:env|file):/.test(value),
          )))
    )
      throw new Error("Unsupported local MCP settings");
    return {
      ...base,
      endpoint: "",
      local: {
        launcher: entry.command[0],
        args: entry.command.slice(1) as string[],
      },
      ...(entry.environment
        ? { environment: entry.environment as Record<string, string> }
        : {}),
    };
  }
  if (
    entry.type !== "remote" ||
    typeof entry.url !== "string" ||
    !/^https:\/\//i.test(entry.url) ||
    Object.keys(entry).some(
      (key) => !["type", "url", "disabled", "oauth"].includes(key),
    ) ||
    (entry.oauth !== undefined && entry.oauth !== false)
  )
    throw new Error("Unsupported remote MCP settings");
  return { ...base, endpoint: entry.url };
}
