import { expect, it } from "vitest";
import { mcpDraft, parseMcpJsonc } from "./mcp-jsonc.js";

it("imports local servers from mcpServers and preserves arguments and environment", () => {
  const entries = parseMcpJsonc(
    JSON.stringify({
      mcpServers: {
        python: {
          command: "uvx",
          args: ["--from", "example-package", "example-server"],
          env: {
            API_KEY: "example-test-key",
            DEBUG: "false",
          },
        },
        node: { type: "stdio", command: "npx", args: ["-y", "example@latest"] },
      },
    }),
  );
  expect(entries.map(([name]) => name)).toEqual(["python", "node"]);
  expect(mcpDraft(...entries[0]!)).toEqual({
    label: "python",
    enabled: true,
    tools: [],
    endpoint: "",
    local: {
      launcher: "uvx",
      args: ["--from", "example-package", "example-server"],
    },
    environment: {
      API_KEY: "example-test-key",
      DEBUG: "false",
    },
  });
  expect(mcpDraft(...entries[1]!)).toEqual({
    label: "node",
    enabled: true,
    tools: [],
    endpoint: "",
    local: { launcher: "npx", args: ["-y", "example@latest"] },
  });
});

it("preserves literal stdio settings with an explicit type and current directory", () => {
  expect(
    mcpDraft("node", {
      type: "stdio",
      command: "npx",
      args: [
        "-y",
        "example@latest",
        "argument with spaces",
        "https://example.test/a",
      ],
      env: { KEY: "a/*b*/ // c", EMPTY: "" },
      cwd: ".",
      disabled: true,
    }),
  ).toMatchObject({
    enabled: false,
    local: {
      launcher: "npx",
      args: [
        "-y",
        "example@latest",
        "argument with spaces",
        "https://example.test/a",
      ],
    },
    environment: { KEY: "a/*b*/ // c", EMPTY: "" },
  });
});

it("rejects malformed mcpServers containers", () => {
  for (const mcpServers of [null, [], {}, "invalid"])
    expect(() => parseMcpJsonc(JSON.stringify({ mcpServers }))).toThrow();
});

it("rejects unsupported stdio settings without dropping fields", () => {
  for (const overrides of [
    { command: "bash" },
    { command: ["uvx", "test"] },
    { type: "http" },
    { args: "test" },
    { args: [1] },
    { args: [] },
    { args: undefined },
    { env: null },
    { env: [] },
    { env: { KEY: false } },
    { env: { KEY: "{env:KEY}" } },
    { env: { KEY: "{file:secret}" } },
    { environment: { KEY: "ignored" } },
    { cwd: "/tmp" },
    { oauth: true },
    { headers: { Authorization: "Bearer test" } },
    { disabled: "true" },
  ]) {
    expect(() =>
      mcpDraft("bad", {
        command: "uvx",
        args: ["test"],
        ...overrides,
      }),
    ).toThrow();
  }
});

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
