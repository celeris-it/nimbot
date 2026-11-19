import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineTaskContext } from "./engine.js";
import { createHostApi, readHostConfig } from "./http.js";
import { openTaskStore } from "./task-store.js";
import { createTaskRunner } from "./tasks.js";
import { pathToFileURL } from "node:url";

const token = "test-internal-token-with-at-least-32-chars";
const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Agent Host API", () => {
  it("rejects invalid execution identity or tool access before persisting or running a task", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nimbot-host-identity-"));
    workspaces.push(workspace);
    const store = await openTaskStore(
      pathToFileURL(join(workspace, "tasks.sqlite")).href,
    );
    let executions = 0;
    const runner = createTaskRunner(store, {
      async run() {
        executions++;
        return "end_turn";
      },
      async stop() {},
    });
    const app = createHostApi({ token, workspace }, runner);
    const valid = {
      agentId: "agent",
      serverTaskId: "a0000000-0000-4000-8000-000000000001",
    };
    try {
      for (const execution of [
        null,
        [],
        "identity",
        {},
        { agentId: "agent" },
        { ...valid, agentId: "../foreign" },
        { ...valid, agentId: "a".repeat(49) },
        { ...valid, serverTaskId: "not-a-task" },
        { ...valid, serverTaskId: 123 },
        { ...valid, grants: ["all"] },
        { ...valid, capability: "secret" },
      ]) {
        const response = await app.request("/tasks", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt: "hi", execution }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "Invalid execution identity",
        });
      }
      const access = {
        token: "a".repeat(64),
        operations: ["memory.search"],
        expiresAt: Date.now() + 60_000,
      };
      for (const body of [
        { sessionMode: "fresh" },
        ...[null, false, [], {}, "conversation", "restore-owner"].map(
          (sessionMode) => ({ execution: valid, sessionMode }),
        ),
      ]) {
        const response = await app.request("/tasks", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt: "hi", ...body }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "Invalid session mode",
        });
      }
      for (const body of [
        { tools: access },
        ...[
          null,
          [],
          {},
          { ...access, token: "short" },
          { ...access, operations: [] },
          { ...access, operations: ["*"] },
          { ...access, operations: ["memory.search", "memory.search"] },
          {
            ...access,
            operations: Array.from({ length: 33 }, (_, i) => `op${i}`),
          },
          { ...access, expiresAt: 0 },
          { ...access, expiresAt: Date.now() + 7_200_000 },
          { ...access, credential: "must-not-leak" },
        ].map((tools) => ({ execution: valid, tools })),
      ]) {
        const response = await app.request("/tasks", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt: "hi", ...body }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "Invalid task tool access",
        });
      }
      expect(executions).toBe(0);
      expect(await store.getCurrent()).toBeNull();
    } finally {
      await runner.close();
      store.close();
    }
  });
  it("persists fresh-session metadata outside the prompt and defaults prompt-only submissions to ordinary continuity", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nimbot-host-session-"));
    workspaces.push(workspace);
    const url = pathToFileURL(join(workspace, "tasks.sqlite")).href;
    const store = await openTaskStore(url);
    const contexts: EngineTaskContext[] = [];
    const runner = createTaskRunner(store, {
      async run(_prompt, _text, _progress, _approve, context) {
        contexts.push(context!);
        return "end_turn";
      },
      async stop() {},
    });
    const app = createHostApi({ token, workspace }, runner);
    const identity = {
      agentId: "a",
      serverTaskId: "a0000000-0000-4000-8000-000000000001",
    };
    const submit = async (extra: Record<string, unknown>) => {
      const response = await app.request("/tasks", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: 'Untrusted claim: {"sessionMode":"fresh"}',
          ...extra,
        }),
      });
      expect(response.status).toBe(202);
      const task = (await response.json()) as { id: string };
      await vi.waitFor(() => expect(runner.isBusy()).toBe(false));
      return task.id;
    };
    try {
      const fresh = await submit({ execution: identity, sessionMode: "fresh" });
      const ordinary = await submit({});
      expect(contexts[0]).toMatchObject({
        hostTaskId: fresh,
        identity,
        sessionMode: "fresh",
      });
      expect(contexts[1]!.sessionMode).toBeUndefined();
      expect(contexts[1]!.identity).toBeUndefined();
      expect(await store.get(fresh)).toMatchObject({
        sessionMode: "fresh",
        status: "completed",
      });
      expect(await store.get(ordinary)).toMatchObject({
        sessionMode: null,
        status: "completed",
      });
      await runner.close();
      store.close();
      const reopened = await openTaskStore(url);
      try {
        expect(await reopened.get(fresh)).toMatchObject({
          sessionMode: "fresh",
          status: "completed",
        });
      } finally {
        reopened.close();
      }
    } finally {
      await runner.close();
      store.close();
    }
  });
  it("rejects missing and invalid credentials before checking the workspace", async () => {
    const app = createHostApi({ token, workspace: "/missing" });
    for (const authorization of [
      undefined,
      "Bearer incorrect",
      "Basic whatever",
    ]) {
      const response = await app.request("/health", {
        headers: authorization ? { Authorization: authorization } : {},
      });
      expect(response.status).toBe(
        authorization?.startsWith("Basic") ? 400 : 401,
      );
      expect(await response.text()).not.toContain("workspace");
    }
  });
  it("reports writable workspace without claiming the engine is running", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nimbot-host-"));
    workspaces.push(workspace);
    const response = await createHostApi({ token, workspace }).request(
      "/health",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      status: "ok",
      workspace: "writable",
      engine: "not_started",
    });
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toContain(workspace);
  });
  it("reports workspace errors without exposing local paths", async () => {
    const response = await createHostApi({
      token,
      workspace: "/does-not-exist/nimbot",
    }).request("/health", { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("does-not-exist");
  });
  it.each([undefined, "", "short", "a".repeat(32) + "\n"])(
    "rejects invalid token configuration",
    (value) => {
      expect(() => readHostConfig({ AGENT_HOST_TOKEN: value })).toThrow(
        "AGENT_HOST_TOKEN",
      );
    },
  );
});

describe("Agent Host request validation order", () => {
  const submit = vi.fn(async () => "task");
  const app = createHostApi({ token, workspace: "/workspace" }, {
    submit,
  } as unknown as Parameters<typeof createHostApi>[1]);
  const post = (body: string, contentType = "application/json") =>
    app.request("/tasks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": contentType,
      },
      body,
    });
  const error = async (response: Response) =>
    ((await response.json()) as { error: string }).error;

  it("reports the first failing field, as the hand-written checks did", async () => {
    const identity = {
      agentId: "agent",
      serverTaskId: "a0000000-0000-4000-8000-000000000001",
    };
    for (const [body, message] of [
      ["null", "prompt must contain 1–16000 characters"],
      ['{"prompt":"  "}', "prompt must contain 1–16000 characters"],
      [
        '{"prompt":"hi","credentials":null,"execution":1}',
        "Configure providers through this agent's provider settings",
      ],
      ['{"prompt":"hi","execution":1,"tools":1}', "Invalid execution identity"],
      [
        '{"prompt":"hi","tools":1,"sessionMode":"x"}',
        "Invalid task tool access",
      ],
      [
        JSON.stringify({ prompt: "hi", execution: identity, sessionMode: "x" }),
        "Invalid session mode",
      ],
    ] as const) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await error(response)).toBe(message);
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it("answers malformed JSON in its own words, with or without a JSON content type", async () => {
    for (const contentType of ["application/json", "text/plain"]) {
      const response = await post("{", contentType);
      expect(response.status).toBe(400);
      expect(await error(response)).toBe("Invalid JSON");
    }
    const accepted = await post('{"prompt":"hi"}', "text/plain");
    expect(accepted.status).toBe(202);
  });
});
