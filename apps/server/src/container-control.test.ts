import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createContainerControl } from "./container-control.js";

it("inspects the configured label and uses the immutable container ID for start/stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-docker-"));
  const socketPath = join(dir, "docker.sock");
  const id = "a".repeat(64);
  let label = "dev";
  let running = false;
  let fail = false;
  let inspectionCode = 200;
  let malformed = false;
  const posts: string[] = [];
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.statusCode = inspectionCode;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          Id: id,
          Config: { Labels: { "io.nimbot.agent-id": label } },
          State: malformed ? {} : { Running: running },
        }),
      );
      return;
    }
    posts.push(req.url!);
    running = req.url!.endsWith("/start");
    res.statusCode = fail ? 500 : 204;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const refs: string[] = [];
  const operations: string[] = [];
  const control = createContainerControl(
    { socketPath, target: "configured-host", agentId: "dev" },
    (value) => refs.push(value),
    (action, status) => operations.push(`${action}:${status}`),
  );
  try {
    expect(await control.status()).toBe("stopped");
    await control.action("start");
    expect(await control.status()).toBe("running");
    await control.action("stop");
    expect(await control.status()).toBe("stopped");
    expect(posts).toEqual([
      `/v1.47/containers/${id}/start`,
      `/v1.47/containers/${id}/stop?t=10`,
    ]);
    expect(refs).toEqual([id, id]);
    expect(operations).toEqual([
      "start:pending",
      "start:completed",
      "stop:pending",
      "stop:completed",
    ]);
    fail = true;
    await expect(control.action("start")).rejects.toThrow("operation failed");
    expect(operations.slice(-2)).toEqual(["start:pending", "start:failed"]);
    const refused = createContainerControl(
      { socketPath, target: "configured-host", agentId: "dev" },
      () => {},
      (_action, status) => {
        if (status === "pending") throw new Error("Storage unavailable");
      },
    );
    await expect(refused.action("start")).rejects.toThrow(
      "Storage unavailable",
    );
    expect(posts).toHaveLength(3);
    inspectionCode = 404;
    expect(await control.status()).toBe("missing");
    await expect(control.action("start")).rejects.toThrow("Container missing");
    expect(posts).toHaveLength(3);
    inspectionCode = 500;
    expect(await control.status()).toBe("unavailable");
    inspectionCode = 200;
    malformed = true;
    expect(await control.status()).toBe("unavailable");
    await expect(control.action("start")).rejects.toThrow();
    expect(posts).toHaveLength(3);
    malformed = false;
    label = "other-agent";
    await expect(control.action("start")).rejects.toThrow("not assigned");
    expect(posts).toHaveLength(3);
    expect(operations.at(-1)).toBe("start:failed");
    expect(await control.status()).toBe("unavailable");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});
it("waits for persisted stop observation before mutation and refuses overlapping actions", async () => {
  const id = "a".repeat(64);
  const operations: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let mutations = 0;
  const control = createContainerControl(
    { socketPath: "/unused", target: id, agentId: "dev" },
    () => {},
    (action, status) => operations.push(`${action}:${status}`),
    async (_path, method = "GET") => {
      if (method === "GET")
        return {
          code: 200,
          body: JSON.stringify({
            Id: id,
            State: { Running: true },
            Config: { Labels: { "io.nimbot.agent-id": "dev" } },
          }),
        };
      mutations++;
      return { code: 204, body: "" };
    },
    async (action) => {
      expect(action).toBe("stop");
      expect(operations).toEqual(["stop:pending"]);
      expect(mutations).toBe(0);
      await pending;
      throw new Error("Observation persistence failed");
    },
  );
  const stopping = control.action("stop");
  await expect(control.action("start")).rejects.toThrow("already running");
  release();
  await expect(stopping).rejects.toThrow("Observation persistence failed");
  expect(mutations).toBe(0);
  expect(operations).toEqual(["stop:pending", "stop:failed"]);
});
