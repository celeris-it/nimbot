import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { text } from "node:stream/consumers";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { createHostApi } from "../apps/agent-host/src/http.js";
import { openTaskStore } from "../apps/agent-host/src/task-store.js";
import { createTaskRunner } from "../apps/agent-host/src/tasks.js";
import {
  createHostApprovals,
  createHostTasks,
} from "../apps/server/src/host/host-tasks.js";

// Exercise the existing bidirectional approval exchange as a transport probe,
// without introducing tool events or changing permission handling yet.
it("round-trips a persisted request with default polling and no Server listener", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nimbot-host-polling-"));
  const store = await openTaskStore(
    pathToFileURL(join(directory, "tasks.sqlite")).href,
  );
  const token = "a".repeat(64);
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let emittedAt = 0;
  let resumedAt = 0;
  let requestTaskId = "";
  let decisionAccepted = false;
  let decision: Promise<void> | undefined;
  const runner = createTaskRunner(
    {
      ...store,
      async approval(id, payload) {
        await store.approval(id, payload);
        requestTaskId = id;
        emittedAt = performance.now();
      },
    },
    {
      async run(_prompt, onText, _progress, approve) {
        await ready;
        const allowed = await approve!("Read transport fixture");
        resumedAt = performance.now();
        onText(allowed ? "confirmed" : "denied");
        return "end_turn";
      },
      async stop() {
        release();
      },
    },
    15000,
    10000,
  );
  const api = createHostApi({ token, workspace: directory }, runner);
  // Native layout: only the Host listens. The Server is an HTTP client with
  // no serverContainerRef, container network attachment, or callback listener.
  const listener = createServer(async (incoming, outgoing) => {
    try {
      const response = await api.request(
        new Request(`http://localhost${incoming.url}`, {
          method: incoming.method,
          headers: incoming.headers as Record<string, string>,
          ...(incoming.method === "POST" ? { body: await text(incoming) } : {}),
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    } catch {
      outgoing.writeHead(500).end();
    }
  });
  let polls = 0;
  const routes: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    routes.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const response = await fetch(input, init);
    if (url.pathname.endsWith("/events") && ++polls === 1) {
      // Emit immediately after a poll took its snapshot: pay a full interval.
      const snapshot = (await response.clone().json()) as {
        events: { status: string }[];
      };
      expect(snapshot.events.some((event) => event.status === "approval")).toBe(
        false,
      );
      release();
    }
    return response;
  };
  try {
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("No Host port");
    const config = { url: `http://127.0.0.1:${address.port}`, token };
    const decide = createHostApprovals(config, request);
    const output = await createHostTasks(config, request)(
      "Measure polling",
      undefined,
      undefined,
      (approval) => {
        decision = decide(approval.taskId, approval.id, true).then((ok) => {
          decisionAccepted = ok;
        });
      },
    );
    await decision;
    expect(output).toBe("confirmed");
    expect(decisionAccepted).toBe(true);
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(emittedAt).toBeGreaterThan(0);
    const elapsed = resumedAt - emittedAt;
    // Keep generous scheduling headroom while guarding the planned 60s call
    // budget. The transport should use roughly one 1s poll, not a full timeout.
    expect(elapsed).toBeGreaterThan(500);
    expect(elapsed).toBeLessThan(5000);
    expect(routes.filter((route) => route === "POST /tasks")).toHaveLength(1);
    expect(
      routes.some((route) =>
        route.startsWith(`POST /tasks/${requestTaskId}/approvals/`),
      ),
    ).toBe(true);
    expect(
      (await store.getEvents(requestTaskId)).some(
        (event) => event.status === "approval",
      ),
    ).toBe(true);
    console.info(
      `Host polling round trip: ${Math.round(elapsed)} ms (60,000 ms planned tool budget)`,
    );
  } finally {
    release();
    await runner.close();
    listener.closeAllConnections();
    if (listener.listening)
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
