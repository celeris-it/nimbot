import { describe, expect, it, vi } from "vitest";
import { createHostTasks, HostTaskError } from "./host-tasks.js";

const config = { url: "http://agent-host:3001", token: "x".repeat(32) };
const accepted = () =>
  Response.json({ id: "task-1", status: "accepted" }, { status: 202 });
describe("internal task client", () => {
  it("submits once and polls persisted state until completion", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(Response.json({ id: "task-1", status: "running" }))
      .mockResolvedValueOnce(
        Response.json({ id: "task-1", status: "completed", output: "Done" }),
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
    expect(request.mock.calls[1]?.[0]).toBe(`${config.url}/tasks/task-1`);
    expect(pause).toHaveBeenCalledOnce();
  });
  it.each(["failed", "interrupted"] as const)("reports %s", async (status) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(Response.json({ id: "task-1", status }));
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
