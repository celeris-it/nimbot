import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHostApi } from "./http.js";
import { openMemoryStore } from "./memory-store.js";
import { createMemoryTools, MEMORY_OPERATIONS } from "./memory-tools.js";
import type { ToolInvocation } from "./tool-bridge.js";

const taskId = "a0000000-0000-4000-8000-000000000001";
const invocation = (): ToolInvocation => ({
  context: {
    hostTaskId: taskId,
    identity: { agentId: "a", serverTaskId: "b" },
    tools: { token: "t", operations: [...MEMORY_OPERATIONS], expiresAt: 1 },
  } as ToolInvocation["context"],
  invocationId: "c0000000-0000-4000-8000-000000000003",
  signal: new AbortController().signal,
});
const fixture = () => {
  const store = openMemoryStore(join(mkdtempSync(join(tmpdir(), "mt-")), "m"));
  const tools = Object.fromEntries(
    createMemoryTools(store).map((tool) => [tool.operation, tool]),
  );
  return { store, tools };
};

it("registers the four memory operations with strict schemas", () => {
  const { tools, store } = fixture();
  expect(Object.keys(tools).sort()).toEqual([...MEMORY_OPERATIONS].sort());
  for (const tool of Object.values(tools))
    expect(tool.inputSchema.additionalProperties).toBe(false);
  store.close();
});

it("creates, searches, updates and deletes through the tools and marks results untrusted", async () => {
  const { tools, store } = fixture();
  const created = (await tools["memory.create"]!.invoke(
    { title: "Port", content: "The API listens on 8080", tags: ["api"] },
    invocation(),
  )) as { id: string };
  const found = (await tools["memory.search"]!.invoke(
    { query: "listens" },
    invocation(),
  )) as { notice: string; memories: { id: string }[] };
  expect(found.memories.map((m) => m.id)).toEqual([created.id]);
  expect(found.notice).toContain("untrusted");
  await tools["memory.update"]!.invoke(
    { id: created.id, title: "Port", content: "Now 9090" },
    invocation(),
  );
  expect(
    (
      (await tools["memory.search"]!.invoke(
        { query: "9090" },
        invocation(),
      )) as {
        memories: unknown[];
      }
    ).memories,
  ).toHaveLength(1);
  expect(
    await tools["memory.delete"]!.invoke({ id: created.id }, invocation()),
  ).toEqual({ deleted: true });
  expect(store.list().memories).toEqual([]);
  expect(store.search("x")).toEqual([]);
  store.close();
});

it("records the Host task as the source and rejects invalid input", async () => {
  const { tools, store } = fixture();
  await tools["memory.create"]!.invoke(
    { title: "t", content: "c" },
    invocation(),
  );
  expect(store.search("c")[0]!.sourceTaskId).toBe(taskId);
  await expect(
    tools["memory.create"]!.invoke({ title: "", content: "c" }, invocation()),
  ).rejects.toThrow();
  await expect(
    tools["memory.update"]!.invoke(
      { id: "nope", title: "t", content: "c" },
      invocation(),
    ),
  ).rejects.toThrow();
  store.close();
});

it("lists and deletes through the authenticated Host API", async () => {
  const { store } = fixture();
  const token = "x".repeat(32);
  const app = createHostApi(
    { token, workspace: "/tmp" },
    undefined,
    undefined,
    store,
  );
  const made = store.create({ title: "Keep", content: "c".repeat(900) }, null);
  const auth = { Authorization: `Bearer ${token}` };
  expect((await app.request("/memories")).status).toBe(401);
  const listed = (await (
    await app.request("/memories", { headers: auth })
  ).json()) as {
    memories: { content: string }[];
  };
  expect(listed.memories[0]!.content.length).toBe(200);
  expect(
    (await app.request("/memories?page=0", { headers: auth })).status,
  ).toBe(400);
  expect(
    (
      await app.request(`/memories/${made.id}/delete`, {
        method: "POST",
        headers: auth,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(`/memories/${made.id}/delete`, {
        method: "POST",
        headers: auth,
      })
    ).status,
  ).toBe(404);
  store.close();
});
