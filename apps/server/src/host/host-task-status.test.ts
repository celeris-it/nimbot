import { expect, it, vi } from "vitest";
import { getHostTaskStatus } from "./host-task-status.js";

const config = { url: "http://agent-host:3001", token: "a".repeat(64) };
const id = "a0000000-0000-4000-8000-000000000001";

it.each(["accepted", "running", "completed", "failed", "interrupted"])(
  "observes the captured task's %s state with authentication",
  async (status) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id, status, output: "private" }));
    expect(await getHostTaskStatus(config, id, request)).toBe(status);
    expect(request).toHaveBeenCalledWith(`${config.url}/tasks/${id}/status`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: expect.any(AbortSignal),
      redirect: "error",
    });
  },
);

it("does not infer interruption from missing, malformed, mismatched or unavailable records", async () => {
  for (const response of [
    new Response("offline", { status: 503 }),
    new Response("not found", { status: 404 }),
    new Response("denied", { status: 401 }),
    new Response("not JSON"),
    Response.json({ id: "other", status: "interrupted" }),
    Response.json({ id, status: "unknown" }),
    Response.json({}),
  ])
    expect(
      await getHostTaskStatus(config, id, async () => response),
    ).toBeUndefined();
  expect(
    await getHostTaskStatus(config, id, async () => {
      throw new Error("private");
    }),
  ).toBeUndefined();
  const request = vi.fn<typeof fetch>();
  expect(
    await getHostTaskStatus(config, "../../current", request),
  ).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
});
