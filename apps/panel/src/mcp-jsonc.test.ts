import { expect, it } from "vitest";
import { mcpDraft, parseMcpJsonc } from "./mcp-jsonc.js";

it("imports selected catalog drafts from an OpenCode JSONC document", () => {
  const entries = parseMcpJsonc(`{
    // Tools
    "mcp": {"servers": {
      "time": {"type":"local", "command":["uvx", "--from", "git+https://example.test/time", "mcp-time",], "disabled":true,},
      "docs": {"type":"remote", "url":"https://example.test/mcp", "oauth": false,},
      "node": {"type":"local", "command":["npx", "-y", "example@latest"], "environment":{"KEY":"a/*b*/ // c"},},
    }},
  }`);
  expect(entries.map(([name]) => name)).toEqual(["time", "docs", "node"]);
  expect(mcpDraft(...entries[0]!)).toMatchObject({
    enabled: false,
    local: {
      launcher: "uvx",
      args: ["--from", "git+https://example.test/time", "mcp-time"],
    },
  });
  expect(mcpDraft(...entries[1]!)).toMatchObject({
    endpoint: "https://example.test/mcp",
  });
  expect(mcpDraft(...entries[2]!)).toMatchObject({
    environment: { KEY: "a/*b*/ // c" },
  });
});

it("rejects invalid JSONC and settings that cannot be mapped to the catalog", () => {
  expect(() => parseMcpJsonc('{"bad": /* no end')).toThrow();
  expect(() =>
    mcpDraft("bad", {
      type: "remote",
      url: "https://example.test/mcp",
      oauth: true,
    }),
  ).toThrow();
  expect(() =>
    mcpDraft("bad", { type: "local", command: ["uvx", "test"], cwd: "/tmp" }),
  ).toThrow();
});
