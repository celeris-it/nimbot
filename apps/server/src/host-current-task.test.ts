import { expect, it, vi } from "vitest";
import { getCurrentHostTask } from "./host-current-task.js";
const config = { url: "http://agent-host:3001", token: "a".repeat(64) };
const id = "a0000000-0000-4000-8000-000000000001";

it.each(["accepted", "running"])(
  "observes %s without exposing prompt or output",
  async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        task: { id, status, prompt: "secret", output: "private" },
      }),
    );
    expect(await getCurrentHostTask(config, request)).toEqual({
      availability: "available",
      task: { id, status },
    });
    expect(request).toHaveBeenCalledWith(`${config.url}/tasks/current`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: expect.any(AbortSignal),
      redirect: "error",
    });
  },
);

it("distinguishes an observed idle Host from unavailable or malformed responses", async () => {
  expect(
    await getCurrentHostTask(config, async () => Response.json({ task: null })),
  ).toEqual({ availability: "available", task: null });
  for (const response of [
    new Response("unauthorized", { status: 401 }),
    new Response("unavailable", { status: 503 }),
    new Response("not JSON"),
    Response.json({}),
    Response.json({ task: { id, status: "completed" } }),
    Response.json({ task: { id: "invalid", status: "running" } }),
  ])
    expect(await getCurrentHostTask(config, async () => response)).toEqual({
      availability: "unavailable",
    });
  expect(
    await getCurrentHostTask(config, async () => {
      throw new Error("network secret");
    }),
  ).toEqual({ availability: "unavailable" });
});
