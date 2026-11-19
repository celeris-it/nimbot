import { afterEach, expect, it } from "vitest";
import { openMcpCatalog } from "./mcp-catalog.js";
import { createMcpToolSelection } from "./mcp-tool-selection.js";
import { createTaskCapabilities } from "./task-capabilities.js";
import { openTaskStore } from "./task-queue.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const settings = {
  label: "Documents",
  endpoint: "https://documents.example.test/mcp",
  enabled: true,
  tools: [
    {
      name: "search",
      access: "read",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ],
};

function fixture() {
  const agents = new Set(["a", "b"]);
  const catalog = openMcpCatalog(":memory:", (id) => agents.has(id));
  cleanups.push(() => catalog.close());
  const definition = catalog.create(settings);
  const selection = createMcpToolSelection(catalog);
  const grant = (agentId = "a") =>
    catalog.grant(agentId, definition.id, catalog.get(definition.id)!.revision);
  return { agents, catalog, definition, selection, grant };
}

it("selects only enabled pinned tools with independent per-agent authority", () => {
  const f = fixture();
  expect(f.selection.descriptors("a")).toEqual([]);
  f.grant();
  f.grant("b");
  const [a] = f.selection.descriptors("a");
  const [b] = f.selection.descriptors("b");
  expect(a!.inputSchema).toEqual(settings.tools[0]!.inputSchema);
  expect(a!.name).toBe(b!.name);
  expect(a!.operation).not.toBe(b!.operation);
  expect(f.selection.resolve("b", a!.operation)).toBeUndefined();
  expect(f.selection.resolve("a", "mcp.invented")).toBeUndefined();
  expect(f.selection.resolve("a", a!.operation)).toMatchObject({
    definitionId: f.definition.id,
    revision: 1,
    endpoint: settings.endpoint,
    tool: settings.tools[0],
  });
  const metadata = JSON.stringify(a);
  expect(Object.keys(a!).sort()).toEqual(["inputSchema", "name", "operation"]);
  expect(metadata).not.toContain(settings.endpoint);
  expect(metadata).not.toContain(
    f.catalog.credentialBinding("a", f.definition.id)!.scope,
  );
  f.catalog.revoke("a", f.definition.id);
  expect(f.selection.resolve("a", a!.operation)).toBeUndefined();
  expect(f.selection.resolve("b", b!.operation)).toBeDefined();
  f.grant();
  expect(f.selection.resolve("a", a!.operation)).toBeUndefined();
  f.agents.delete("b");
  expect(f.selection.descriptors("b")).toEqual([]);
});

it("invalidates old operations on edits, disable/re-enable and credential replacement", () => {
  const f = fixture();
  f.grant();
  let revision = 1;
  const oldOperations: string[] = [];
  for (const update of [
    { ...settings, tools: [{ ...settings.tools[0], access: "write" }] },
    {
      ...settings,
      tools: [{ ...settings.tools[0], inputSchema: { type: "object" } }],
    },
    { ...settings, enabled: false },
    settings,
  ]) {
    oldOperations.push(...f.selection.descriptors("a").map((d) => d.operation));
    f.catalog.update(f.definition.id, revision++, update);
    for (const operation of oldOperations)
      expect(f.selection.resolve("a", operation)).toBeUndefined();
  }
  const [before] = f.selection.descriptors("a");
  const binding = f.catalog.credentialBinding("a", f.definition.id)!;
  expect(
    f.catalog.replaceCredential(
      "a",
      f.definition.id,
      binding,
      "server-private-reference",
    ),
  ).toBe(true);
  expect(f.selection.resolve("a", before!.operation)).toBeUndefined();
  expect(JSON.stringify(f.selection.descriptors("a"))).not.toContain(
    "server-private-reference",
  );
  const withCredential = f.selection.descriptors("a")[0]!;
  expect(
    f.catalog.replaceCredential(
      "a",
      f.definition.id,
      f.catalog.credentialBinding("a", f.definition.id)!,
      null,
    ),
  ).toBe(true);
  // Returning to no credential must not resurrect the earlier credential-free lease.
  expect(f.selection.resolve("a", before!.operation)).toBeUndefined();
  expect(f.selection.resolve("a", withCredential.operation)).toBeUndefined();
  expect(f.catalog.replaceCredential("a", f.definition.id, binding, null)).toBe(
    false,
  );
  f.catalog.update(f.definition.id, revision, {
    ...settings,
    endpoint: "https://replacement.example.test/mcp",
  });
  expect(f.selection.descriptors("a")).toEqual([]);
});

it("bounds tool count and total metadata, preserving room for local operations", () => {
  const f = fixture();
  f.catalog.update(f.definition.id, 1, {
    ...settings,
    tools: Array.from({ length: 32 }, (_, i) => ({
      ...settings.tools[0],
      name: `search_${i}`,
    })),
  });
  f.grant();
  expect(f.selection.descriptors("a")).toHaveLength(23);
  f.catalog.update(f.definition.id, 2, {
    ...settings,
    tools: [
      {
        ...settings.tools[0],
        name: "large",
        inputSchema: { type: "object", description: "x".repeat(16_100) },
      },
      ...settings.tools,
    ],
  });
  const descriptors = f.selection.descriptors("a");
  expect(Buffer.byteLength(JSON.stringify(descriptors))).toBeLessThanOrEqual(
    16_384,
  );
  expect(descriptors).toHaveLength(1);
  descriptors[0]!.inputSchema.type = "array";
  expect(f.selection.descriptors("a")[0]!.inputSchema.type).toBe("object");
});

it("validates arguments only against currently granted pinned schemas", () => {
  const f = fixture();
  f.grant();
  const operation = f.selection.descriptors("a")[0]!.operation;
  const args = { query: "hello" };
  expect(f.selection.validate("a", operation, args)).toBe(args);
  expect(f.selection.validate("a", operation, { query: 1 })).toBeUndefined();
  expect(f.selection.validate("a", operation, {})).toBeUndefined();
  expect(
    f.selection.validate("a", operation, {
      ...args,
      endpoint: settings.endpoint,
    }),
  ).toBeUndefined();
  expect(f.selection.validate("b", operation, args)).toBeUndefined();
  f.catalog.update(f.definition.id, 1, {
    ...settings,
    tools: [
      {
        ...settings.tools[0],
        inputSchema: {
          type: "object",
          properties: { count: { type: "integer" } },
          required: ["count"],
          additionalProperties: false,
        },
      },
    ],
  });
  expect(f.selection.validate("a", operation, args)).toBeUndefined();
  const changed = f.selection.descriptors("a")[0]!.operation;
  expect(f.selection.validate("a", changed, args)).toBeUndefined();
  expect(f.selection.validate("a", changed, { count: 1 })).toEqual({
    count: 1,
  });
  f.catalog.revoke("a", f.definition.id);
  expect(f.selection.validate("a", changed, { count: 1 })).toBeUndefined();
});

it("fits catalog tools alongside all memory and peer operations in one capability", () => {
  const f = fixture();
  f.catalog.update(f.definition.id, 1, {
    ...settings,
    tools: Array.from({ length: 32 }, (_, index) => ({
      ...settings.tools[0],
      name: `tool_${index}`,
    })),
  });
  f.grant();
  const store = openTaskStore(":memory:");
  cleanups.push(() => store.close());
  const task = store.enqueue({
    agentId: "a",
    botId: 1,
    chatId: 2,
    prompt: "Use tools",
  });
  store.claimNextTask("a");
  const local = [
    "memory.create",
    "memory.search",
    "memory.update",
    "memory.delete",
    "agent.list",
    "agent.note.send",
    "agent.note.read",
    "agent.delegate",
    "agent.delegation.status",
  ];
  const capabilities = createTaskCapabilities({
    store,
    policy: {
      canExecute: () => true,
      allowedOperations: () => local,
      remoteTools: (task) => f.selection.descriptors(task.agentId),
    },
  });
  cleanups.push(() => capabilities.close());
  const lease = capabilities.issue(
    "a",
    task.id,
    new AbortController().signal,
    10_000,
  )!;
  expect(lease.operations).toHaveLength(32);
  expect(lease.operations).toEqual(expect.arrayContaining(local));
  expect(lease.remoteTools).toHaveLength(23);
});

it("revokes a live task capability when its pinned catalog revision changes", () => {
  const f = fixture();
  f.grant();
  const store = openTaskStore(":memory:");
  cleanups.push(() => store.close());
  const task = store.enqueue({
    agentId: "a",
    botId: 1,
    chatId: 2,
    prompt: "Search",
  });
  store.claimNextTask("a");
  const hostTaskId = "a0000000-0000-4000-8000-000000000001";
  store.bindHostTask("a", task.id, hostTaskId);
  const capabilities = createTaskCapabilities({
    store,
    policy: {
      canExecute: () => true,
      allowedOperations: () => [],
      remoteTools: (task) => f.selection.descriptors(task.agentId),
    },
  });
  cleanups.push(() => capabilities.close());
  const lease = capabilities.issue(
    "a",
    task.id,
    new AbortController().signal,
    10_000,
  )!;
  const call = {
    agentId: "a",
    serverTaskId: task.id,
    hostTaskId,
    token: lease.token,
    operation: lease.operations[0]!,
  };
  expect(capabilities.verify(call)).toBeDefined();
  expect(f.catalog.blockTool(f.definition.id, 1, "search")).toBe(true);
  expect(f.selection.descriptors("a")).toEqual([]);
  expect(capabilities.verify(call)).toBeUndefined();
  f.catalog.update(f.definition.id, 2, {
    ...settings,
    reviewedTools: ["search"],
  });
  expect(f.selection.descriptors("a")).toHaveLength(1);
  expect(capabilities.verify(call)).toBeUndefined();
});
