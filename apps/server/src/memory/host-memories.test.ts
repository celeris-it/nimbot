import { expect, it, vi } from "vitest";
import { createPanel } from "../panel.js";
import { hashPassword } from "../panel-auth.js";
import { readPanelConfig } from "../panel-config.js";
import { createHostMemories, HostMemoryError } from "./host-memories.js";

const host = { url: "http://agent-a:3001", token: "x".repeat(32) };
const id = "a0000000-0000-4000-8000-000000000001";

it("lists with bounds, skips malformed entries and never follows redirects", async () => {
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({
      memories: [
        {
          id,
          title: "T",
          content: "c".repeat(900),
          tags: ["a", 5],
          updatedAt: 1,
          expiresAt: null,
        },
        { id: "bad", title: "T", content: "c", tags: [], updatedAt: 1 },
        null,
      ],
      hasMore: true,
    }),
  );
  const memories = createHostMemories(async () => host, request);
  const result = await memories.list("a", 2);
  expect(result.memories).toEqual([
    {
      id,
      title: "T",
      preview: "c".repeat(200),
      tags: ["a"],
      updatedAt: 1,
      expiresAt: null,
    },
  ]);
  expect(result.hasMore).toBe(true);
  expect(request.mock.calls[0]?.[0]).toBe(
    "http://agent-a:3001/memories?page=2",
  );
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    redirect: "error",
    headers: { Authorization: `Bearer ${host.token}` },
  });
  await expect(memories.list("a", 0)).rejects.toBeInstanceOf(HostMemoryError);
});

it("maps Host failures and rejects invalid IDs before any request", async () => {
  const request = vi.fn<typeof fetch>(
    async () => new Response("{}", { status: 404 }),
  );
  const memories = createHostMemories(async () => host, request);
  await expect(memories.remove("a", id)).rejects.toMatchObject({ status: 404 });
  await expect(memories.remove("a", "../../x")).rejects.toMatchObject({
    status: 400,
  });
  expect(request).toHaveBeenCalledTimes(1);
  const down = createHostMemories(
    async () => host,
    async () => {
      throw new Error("private detail");
    },
  );
  await expect(down.list("a", 1)).rejects.toMatchObject({ status: 503 });
});

it("protects panel memory operations by session, Origin and agent", async () => {
  const config = readPanelConfig({
    PANEL_PASSWORD_HASH: await hashPassword("test-password"),
  });
  const memories = {
    list: vi.fn(async () => ({ memories: [], hasMore: false })),
    remove: vi.fn(async () => {}),
  };
  const app = createPanel(config, {
    memories,
    getAgentSetup: (agent) =>
      agent === "a"
        ? { name: "a", botUsername: null, provisioning: "ready" }
        : undefined,
  });
  expect((await app.request("/api/agents/a/memories")).status).toBe(401);
  const login = await app.request("/api/login", {
    method: "POST",
    headers: {
      Origin: config.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "password=test-password",
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (
      await app.request("/api/agents/a/memories?page=2", {
        headers: { Cookie: cookie },
      })
    ).status,
  ).toBe(200);
  expect(memories.list).toHaveBeenCalledWith("a", 2);
  expect(
    (
      await app.request("/api/agents/b/memories", {
        headers: { Cookie: cookie },
      })
    ).status,
  ).toBe(404);
  const del = (origin: string) =>
    app.request(`/api/agents/a/memories/${id}/delete`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin },
    });
  expect((await del("https://evil.example")).status).toBe(403);
  expect(memories.remove).not.toHaveBeenCalled();
  expect((await del(config.origin)).status).toBe(200);
  expect(memories.remove).toHaveBeenCalledWith("a", id);
});
