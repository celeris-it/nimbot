import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { openMcpCatalog } from "./mcp-catalog.js";

const settings = {
  label: "Workspace docs",
  endpoint: "https://docs.example.test/mcp",
  enabled: true,
  tools: [
    {
      name: "search",
      access: "read",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
    {
      name: "add",
      access: "write",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
      },
    },
  ],
};

it("persists blocked tools, invalidates stale edits and requires an explicit review to clear them", () => {
  const directory = mkdtempSync(join(tmpdir(), "nimbot-mcp-review-"));
  const path = join(directory, "server.sqlite");
  let catalog = openMcpCatalog(path, () => true);
  try {
    const saved = catalog.create(settings);
    catalog.grant("a", saved.id, 1);
    expect(catalog.blockTool(saved.id, 1, "unselected")).toBe(false);
    expect(catalog.blockTool(saved.id, 1, "search")).toBe(true);
    expect(catalog.get(saved.id)).toMatchObject({
      revision: 2,
      blockedTools: ["search"],
    });
    expect(catalog.blockTool(saved.id, 2, "search")).toBe(false);
    expect(
      catalog.update(saved.id, 1, { ...settings, reviewedTools: ["search"] }),
    ).toBeUndefined();
    catalog.close();
    catalog = openMcpCatalog(path, () => true);
    expect(catalog.list()[0]!.blockedTools).toEqual(["search"]);
    for (const enabled of [false, true]) {
      const current = catalog.get(saved.id)!;
      expect(
        catalog.update(saved.id, current.revision, {
          ...settings,
          label: "Renamed",
          enabled,
          blockedTools: [],
        })!.blockedTools,
      ).toEqual(["search"]);
    }
    const current = catalog.get(saved.id)!;
    expect(
      catalog.update(saved.id, current.revision, {
        ...settings,
        reviewedTools: ["search"],
      })!.blockedTools,
    ).toBeUndefined();
    expect(catalog.blockTool(saved.id, 2, "search")).toBe(false);
    expect(catalog.grants("a")).toEqual([saved.id]);
    expect(
      catalog.blockTool(saved.id, catalog.get(saved.id)!.revision, "add"),
    ).toBe(true);
    const withBlock = catalog.get(saved.id)!;
    expect(() =>
      catalog.update(saved.id, withBlock.revision, {
        ...settings,
        reviewedTools: ["unknown"],
      }),
    ).toThrow("review selection");
    expect(catalog.get(saved.id)).toEqual(withBlock);
    expect(
      catalog.update(saved.id, withBlock.revision, {
        ...settings,
        tools: [settings.tools[0]],
      })!.blockedTools,
    ).toBeUndefined();
  } finally {
    catalog.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("rolls back settings, grants and review state together if clearing a block fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "nimbot-mcp-review-rollback-"));
  const path = join(directory, "server.sqlite");
  const catalog = openMcpCatalog(path, () => true);
  const connection = new DatabaseSync(path);
  try {
    const saved = catalog.create(settings);
    catalog.grant("a", saved.id, 1);
    catalog.blockTool(saved.id, 1, "search");
    const blocked = catalog.get(saved.id)!;
    connection.exec(
      "CREATE TRIGGER refuse_review BEFORE DELETE ON mcp_tool_blocks BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;",
    );
    expect(() =>
      catalog.update(saved.id, blocked.revision, {
        ...settings,
        endpoint: "https://replacement.example.test/mcp",
        reviewedTools: ["search"],
      }),
    ).toThrow();
    expect(catalog.get(saved.id)).toEqual(blocked);
    expect(catalog.grants("a")).toEqual([saved.id]);
  } finally {
    connection.close();
    catalog.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("persists stable definitions and independent, default-denied agent grants", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbot-mcp-catalog-"));
  const agents = new Set(["a", "b"]);
  const open = () =>
    openMcpCatalog(join(dir, "server.sqlite"), (id) => agents.has(id));
  let catalog = open();
  try {
    const saved = catalog.create(settings);
    expect(saved).toMatchObject({ ...settings, revision: 1 });
    expect(catalog.grants("a")).toEqual([]);
    expect(catalog.grant("missing", saved.id, saved.revision)).toBe(false);
    expect(catalog.grant("a", "missing", saved.revision)).toBe(false);
    expect(catalog.grant("a", saved.id, saved.revision)).toBe(true);
    expect(catalog.grant("a", saved.id, saved.revision)).toBe(false);
    expect(catalog.grant("b", saved.id, saved.revision)).toBe(true);
    catalog.close();
    catalog = open();
    expect(catalog.list()).toEqual([saved]);
    expect(catalog.get(saved.id)).toEqual(saved);
    expect(catalog.revoke("a", saved.id)).toBe(true);
    expect(catalog.grants("a")).toEqual([]);
    expect(catalog.grants("b")).toEqual([saved.id]);
    agents.delete("b");
    expect(catalog.grants("b")).toEqual([]);
  } finally {
    catalog.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects stale edits and requires new grants when the endpoint changes", () => {
  const catalog = openMcpCatalog(":memory:", () => true);
  try {
    const saved = catalog.create(settings);
    expect(catalog.grant("a", saved.id, saved.revision)).toBe(true);
    const renamed = { ...settings, label: "Renamed", enabled: false };
    expect(catalog.update(saved.id, saved.revision, renamed)).toMatchObject({
      ...renamed,
      id: saved.id,
      revision: saved.revision + 1,
    });
    expect(catalog.grants("a")).toEqual([saved.id]);
    const replacement = {
      ...settings,
      endpoint: "https://other.example.test/mcp",
    };
    expect(
      catalog.update(saved.id, saved.revision, replacement),
    ).toBeUndefined();
    expect(catalog.grants("a")).toEqual([saved.id]);
    const current = catalog.update(saved.id, saved.revision + 1, replacement)!;
    expect(current).toMatchObject({ ...replacement, id: saved.id });
    expect(catalog.grants("a")).toEqual([]);
    expect(catalog.grant("a", saved.id, saved.revision + 1)).toBe(false);
    expect(catalog.grant("a", saved.id, current.revision)).toBe(true);
  } finally {
    catalog.close();
  }
});

it("rejects disallowed endpoints, ambiguous tools, and oversized schemas", () => {
  const catalog = openMcpCatalog(":memory:", () => true);
  try {
    for (const endpoint of [
      "http://docs.example.test/mcp",
      "https://alice:password@docs.example.test/mcp",
      "https://docs.example.test/mcp#fragment",
      "/mcp",
    ])
      expect(() => catalog.create({ ...settings, endpoint })).toThrow();
    for (const tools of [
      [settings.tools[0], settings.tools[0]],
      [{ ...settings.tools[0], access: undefined }],
      [{ ...settings.tools[0], inputSchema: { type: "array" } }],
      [
        {
          ...settings.tools[0],
          inputSchema: { type: "object", description: "😀".repeat(4096) },
        },
      ],
    ])
      expect(() => catalog.create({ ...settings, tools })).toThrow();
    expect(catalog.list()).toEqual([]);
  } finally {
    catalog.close();
  }
});

it("rejects unsupported schemas atomically without replacing the approved definition", () => {
  const catalog = openMcpCatalog(":memory:", () => true);
  try {
    const saved = catalog.create(settings);
    for (const inputSchema of [
      { type: "object", required: "text" },
      {
        type: "object",
        properties: {
          text: { $ref: "https://unapproved.example.test/schema" },
        },
      },
      { type: "object", unknownConstraint: true },
      { type: "object", $async: true },
    ]) {
      const changed = {
        ...settings,
        tools: [{ ...settings.tools[0], inputSchema }],
      };
      expect(() => catalog.create(changed)).toThrow(
        "Invalid or unsupported MCP tool schema.",
      );
      expect(() => catalog.update(saved.id, 1, changed)).toThrow(
        "Invalid or unsupported MCP tool schema.",
      );
      expect(catalog.get(saved.id)).toEqual(saved);
      expect(catalog.list()).toEqual([saved]);
    }
  } finally {
    catalog.close();
  }
});
