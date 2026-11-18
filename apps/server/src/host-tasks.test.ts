import { describe, expect, it, vi } from "vitest";
import {
  createHostApprovals,
  createHostTasks,
  HostTaskError,
  type HostTaskExecution,
} from "./host-tasks.js";

const config = { url: "http://agent-host:3001", token: "x".repeat(32) };
const accepted = () =>
  Response.json({ id: "task-1", status: "accepted" }, { status: 202 });
describe("internal task client", () => {
  const hostTaskId = "a0000000-0000-4000-8000-000000000001";
  const identity = {
    agentId: "a",
    serverTaskId: "b0000000-0000-4000-8000-000000000002",
  };

  it("submits correlation separately and binds it before observing events", async () => {
    const order: string[] = [];
    const request = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/tasks"))
        return Response.json({ id: hostTaskId, status: "accepted" });
      order.push("events");
      return Response.json({
        id: hostTaskId,
        events: [{ sequence: 1, status: "completed", output: "done" }],
      });
    });
    expect(
      await createHostTasks(config, request)(
        "prompt",
        undefined,
        undefined,
        undefined,
        {
          identity,
          onAccepted(id) {
            expect(id).toBe(hostTaskId);
            order.push("bound");
            return true;
          },
        },
      ),
    ).toBe("done");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      prompt: "prompt",
      execution: identity,
    });
    expect(order).toEqual(["bound", "events"]);
  });

  it.each(["rejected", "throws", "invalid-id"])(
    "cancels accepted work when correlation %s and never polls or retries it",
    async (failure) => {
      const id = failure === "invalid-id" ? "not-a-host-id" : hostTaskId;
      const request = vi.fn<typeof fetch>(async () =>
        Response.json({ id, status: "accepted" }),
      );
      const onAccepted = vi.fn(() => {
        if (failure === "throws") throw new Error("private storage failure");
        return false;
      });
      await expect(
        createHostTasks(config, request)(
          "prompt",
          undefined,
          undefined,
          undefined,
          { identity, onAccepted },
        ),
      ).rejects.toEqual(new HostTaskError("unavailable"));
      expect(request.mock.calls.map(([url]) => String(url))).toEqual([
        `${config.url}/tasks`,
        `${config.url}/tasks/${id}/cancel`,
      ]);
      if (failure === "invalid-id") expect(onAccepted).not.toHaveBeenCalled();
    },
  );
  it("submits once and polls persisted state until completion", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(
        Response.json({
          id: "task-1",
          events: [{ sequence: 1, status: "running" }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "task-1",
          events: [{ sequence: 2, status: "completed", output: "Done" }],
        }),
      );
    const pause = vi.fn().mockResolvedValue(undefined);
    expect(await createHostTasks(config, request, pause)("create a file")).toBe(
      "Done",
    );
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0]).toEqual([
      `${config.url}/tasks`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prompt: "create a file" }),
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        redirect: "error",
      }),
    ]);
    expect(request.mock.calls[1]?.[0]).toBe(
      `${config.url}/tasks/task-1/events?after=0`,
    );
    expect(request.mock.calls[2]?.[0]).toBe(
      `${config.url}/tasks/task-1/events?after=1`,
    );
    expect(pause).toHaveBeenCalledOnce();
  });
  it.each(["failed", "interrupted"] as const)("reports %s", async (status) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(
        Response.json({ id: "task-1", events: [{ sequence: 1, status }] }),
      );
    await expect(
      createHostTasks(config, request)("hello"),
    ).rejects.toMatchObject({ kind: status });
  });
  it("reports busy without retrying", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 409 }));
    await expect(
      createHostTasks(config, request)("hello"),
    ).rejects.toMatchObject({ kind: "busy" });
    expect(request).toHaveBeenCalledOnce();
  });
  it("does not retry ambiguous submissions or expose errors", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("secret"));
    await expect(createHostTasks(config, request)("hello")).rejects.toEqual(
      new HostTaskError("unavailable"),
    );
    expect(request).toHaveBeenCalledOnce();
  });
  it.each([
    { id: "other", status: "completed", output: "wrong" },
    { id: "task-1", status: "unknown" },
    { id: "task-1", events: [{ sequence: 0, status: "running" }] },
    { id: "task-1", events: [{ sequence: 1, status: "unknown" }] },
    null,
  ])("rejects malformed or mismatched results", async (task) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(Response.json(task));
    await expect(
      createHostTasks(config, request)("hello"),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });
});

it("passes progress events to the callback in order and still returns the result", async () => {
  const events = [
    { sequence: 1, status: "running" },
    { sequence: 2, status: "progress", output: "Using tool: read" },
    { sequence: 3, status: "progress", output: "Using tool: edit" },
    { sequence: 4, status: "completed", output: "all done" },
  ];
  const request = (async (input: string | URL | Request) =>
    String(input).endsWith("/tasks")
      ? Response.json({ id: "t1", status: "accepted" }, { status: 202 })
      : Response.json({ id: "t1", events })) as typeof fetch;
  const seen: string[] = [];
  const run = createHostTasks(
    { url: "http://host:3001", token: "a".repeat(64) },
    request,
    async () => {},
  );
  expect(await run("go", (message) => seen.push(message))).toBe("all done");
  expect(seen).toEqual(["Using tool: read", "Using tool: edit"]);
  const bad = (async (input: string | URL | Request) =>
    String(input).endsWith("/tasks")
      ? Response.json({ id: "t1", status: "accepted" }, { status: 202 })
      : Response.json({
          id: "t1",
          events: [
            { sequence: 1, status: "progress", output: "x" },
            { sequence: 2, status: "completed", output: "ok" },
          ],
        })) as typeof fetch;
  expect(
    await createHostTasks(
      { url: "http://host:3001", token: "a".repeat(64) },
      bad,
      async () => {},
    )("go", () => {
      throw new Error("ignored");
    }),
  ).toBe("ok");
});

describe("task cancellation", () => {
  const host = { url: "http://host:3001", token: "a".repeat(64) };
  function fake(finalStatus: "cancelled" | "completed" = "cancelled") {
    const requests: string[] = [];
    let cancelled = false;
    const request = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/tasks"))
        return Response.json({ id: "t1", status: "accepted" }, { status: 202 });
      if (url.endsWith("/cancel")) {
        cancelled = true;
        return Response.json(
          { id: "t1", status: "cancelling" },
          { status: 202 },
        );
      }
      return Response.json({
        id: "t1",
        events: cancelled
          ? [{ sequence: 2, status: finalStatus, output: "partial" }]
          : [{ sequence: 1, status: "running" }],
      });
    }) as typeof fetch;
    return { request, requests };
  }

  it("asks the Host to cancel the exact task and reports cancellation", async () => {
    const { request, requests } = fake();
    const controller = new AbortController();
    const run = createHostTasks(host, request, async () => {
      controller.abort();
    });
    await expect(run("go", undefined, controller.signal)).rejects.toMatchObject(
      { kind: "cancelled" },
    );
    expect(requests).toContain("POST http://host:3001/tasks/t1/cancel");
  });

  it("does not submit anything when already cancelled", async () => {
    const { request, requests } = fake();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createHostTasks(host, request)("go", undefined, controller.signal),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(requests).toEqual([]);
  });

  it("cancels a task accepted after the signal fired and still returns a completed result", async () => {
    const { request, requests } = fake("completed");
    const controller = new AbortController();
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/tasks")) controller.abort();
      return request(input, init);
    }) as typeof fetch;
    await expect(
      createHostTasks(host, slow, async () => {})(
        "go",
        undefined,
        controller.signal,
      ),
    ).resolves.toBe("partial");
    expect(requests.some((entry) => entry.endsWith("/tasks/t1/cancel"))).toBe(
      true,
    );
  });
});

it("gives up after its wait limit, tells the Host to cancel that task, and reports a timeout", async () => {
  const requests: string[] = [];
  const request = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/tasks"))
      return Response.json({ id: "t9", status: "accepted" }, { status: 202 });
    if (url.endsWith("/cancel"))
      return Response.json({ id: "t9", status: "cancelling" }, { status: 202 });
    return Response.json({ id: "t9", events: [] });
  }) as typeof fetch;
  const run = createHostTasks(
    { url: "http://host:3001", token: "a".repeat(64) },
    request,
    () => new Promise((resolve) => setTimeout(resolve, 5)),
    40,
  );
  await expect(run("hang")).rejects.toMatchObject({ kind: "timeout" });
  expect(requests).toContain("POST http://host:3001/tasks/t9/cancel");
});

describe("approvals", () => {
  const host = { url: "http://host:3001", token: "a".repeat(64) };
  const approvalId = "11111111-2222-3333-4444-555555555555";

  it("hands approval requests to the callback and still returns the result", async () => {
    const request = (async (input: string | URL | Request) =>
      String(input).endsWith("/tasks")
        ? Response.json({ id: "t1", status: "accepted" }, { status: 202 })
        : Response.json({
            id: "t1",
            events: [
              {
                sequence: 1,
                status: "approval",
                output: JSON.stringify({
                  id: approvalId,
                  title: "read /etc/hostname",
                }),
              },
              { sequence: 2, status: "completed", output: "done" },
            ],
          })) as typeof fetch;
    const seen: unknown[] = [];
    expect(
      await createHostTasks(host, request, async () => {})(
        "go",
        undefined,
        undefined,
        (a) => seen.push(a),
      ),
    ).toBe("done");
    expect(seen).toEqual([
      { taskId: "t1", id: approvalId, title: "read /etc/hostname" },
    ]);
  });

  it("rejects a malformed approval event instead of guessing", async () => {
    const request = (async (input: string | URL | Request) =>
      String(input).endsWith("/tasks")
        ? Response.json({ id: "t1", status: "accepted" }, { status: 202 })
        : Response.json({
            id: "t1",
            events: [{ sequence: 1, status: "approval", output: "not json" }],
          })) as typeof fetch;
    await expect(
      createHostTasks(host, request, async () => {})("go"),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("sends the decision to the exact task and approval, authenticated", async () => {
    const calls: {
      url: string;
      method?: string;
      auth: string | null;
      body: unknown;
    }[] = [];
    const request = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({
        url: String(input),
        method: init?.method,
        auth: new Headers(init?.headers).get("Authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ status: "recorded" });
    }) as typeof fetch;
    const decide = createHostApprovals(host, request);
    expect(await decide("t1", approvalId, true)).toBe(true);
    expect(await decide("t1", approvalId, false)).toBe(true);
    expect(calls).toEqual([
      {
        url: `http://host:3001/tasks/t1/approvals/${approvalId}`,
        method: "POST",
        auth: `Bearer ${host.token}`,
        body: { decision: "allow" },
      },
      expect.objectContaining({ body: { decision: "deny" } }),
    ]);
    const failing = (async () =>
      Response.json({}, { status: 404 })) as typeof fetch;
    expect(
      await createHostApprovals(host, failing)("t1", approvalId, true),
    ).toBe(false);
    const down = (async () => {
      throw new TypeError("down");
    }) as typeof fetch;
    expect(await createHostApprovals(host, down)("t1", approvalId, true)).toBe(
      false,
    );
  });
});

describe("Agent Host restart while a task is observed", () => {
  const eventsResponse = (events: unknown[]) =>
    Response.json({ id: "task-1", events });
  it("keeps polling through a short outage and reports the interruption the Host recorded", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(
        eventsResponse([{ sequence: 1, status: "running" }]),
      )
      .mockRejectedValueOnce(new TypeError("connection refused"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        eventsResponse([{ sequence: 2, status: "interrupted" }]),
      );
    const pause = vi.fn().mockResolvedValue(undefined);
    await expect(
      createHostTasks(config, request, pause)("hello"),
    ).rejects.toMatchObject({ kind: "interrupted" });
    // The task was submitted once and the cursor was kept across the outage.
    expect(
      request.mock.calls.filter(([url]) => String(url).endsWith("/tasks")),
    ).toHaveLength(1);
    expect(String(request.mock.calls.at(-1)![0])).toContain("after=1");
  });
  it("gives up after a bounded number of failed polls and reports unavailable", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accepted())
      .mockRejectedValue(new TypeError("connection refused"));
    const pause = vi.fn().mockResolvedValue(undefined);
    await expect(
      createHostTasks(config, request, pause)("hello"),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(request.mock.calls.length).toBeLessThanOrEqual(20);
    expect(request.mock.calls.length).toBeGreaterThan(2);
  });
});

describe("tool relay", () => {
  const hostTaskId = "a0000000-0000-4000-8000-000000000001";
  const invocationId = "c0000000-0000-4000-8000-000000000003";
  const identity = {
    agentId: "a",
    serverTaskId: "b0000000-0000-4000-8000-000000000002",
  };
  function host(events: unknown[][]) {
    let poll = 0;
    const replies: { url: string; body: unknown }[] = [];
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/tasks"))
        return Response.json({ id: hostTaskId, status: "accepted" });
      if (url.includes("/tool-requests/")) {
        replies.push({ url, body: JSON.parse(String(init?.body)) });
        return Response.json({ status: "recorded" });
      }
      return Response.json({ id: hostTaskId, events: events[poll++] ?? [] });
    });
    return { request, replies };
  }
  const toolEvent = {
    sequence: 1,
    status: "tool_request",
    output: JSON.stringify({
      invocationId,
      operation: "x.op",
      arguments: { a: 1 },
      deadline: 1,
    }),
  };

  it("answers a tool request through the Host result endpoint", async () => {
    const f = host([
      [toolEvent],
      [{ sequence: 2, status: "completed", output: "done" }],
    ]);
    const onTool = vi.fn<NonNullable<HostTaskExecution["onTool"]>>(
      async () => ({ ok: true, result: 7 }),
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = createHostTasks(config, f.request, () => gate)(
      "p",
      undefined,
      undefined,
      undefined,
      { identity, onTool, onAccepted: () => true },
    );
    await vi.waitFor(() => expect(f.replies).toHaveLength(1));
    release();
    expect(await run).toBe("done");
    expect(onTool.mock.calls[0]?.[0]).toEqual({
      hostTaskId,
      invocationId,
      operation: "x.op",
      arguments: { a: 1 },
    });
    expect(f.replies[0]).toEqual({
      url: `${config.url}/tasks/${hostTaskId}/tool-requests/${invocationId}/result`,
      body: { ok: true, result: 7 },
    });
  });

  it("denies tool requests when no handler is attached", async () => {
    const f = host([
      [toolEvent],
      [{ sequence: 2, status: "completed", output: "done" }],
    ]);
    await createHostTasks(config, f.request, () => Promise.resolve())(
      "p",
      undefined,
      undefined,
      undefined,
      { identity, onAccepted: () => true },
    );
    await vi.waitFor(() => expect(f.replies).toHaveLength(1));
    expect(f.replies[0]?.body).toEqual({ ok: false, error: "denied" });
  });

  it("aborts the call on tool_cancel and sends no reply", async () => {
    const f = host([
      [toolEvent],
      [
        {
          sequence: 2,
          status: "tool_cancel",
          output: JSON.stringify({ invocationId }),
        },
      ],
      [{ sequence: 3, status: "completed", output: "done" }],
    ]);
    let aborted = false;
    const onTool = vi.fn(
      (_request: unknown, signal: AbortSignal) =>
        new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          }),
        ),
    );
    await createHostTasks(config, f.request, () => Promise.resolve())(
      "p",
      undefined,
      undefined,
      undefined,
      { identity, onTool, onAccepted: () => true },
    );
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(f.replies).toHaveLength(0);
  });
});
