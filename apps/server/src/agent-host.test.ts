import { describe, expect, it, vi } from "vitest";
import { getHostStatus } from "./agent-host.js";

const config = { url: "http://agent-host:3001", token: "x".repeat(32) };

describe("Agent Host connection", () => {
  it.each([
    ["not_started", "ready"],
    ["busy", "busy"],
  ] as const)(
    "maps %s and sends only the internal credential",
    async (engine, expected) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ status: "ok", workspace: "writable", engine }),
        );
      expect(await getHostStatus(config, request)).toBe(expected);
      expect(request).toHaveBeenCalledWith(`${config.url}/health`, {
        headers: { Authorization: `Bearer ${config.token}` },
        signal: expect.any(AbortSignal),
        redirect: "error",
      });
    },
  );

  it("reports authentication failures, invalid responses and network errors as unavailable", async () => {
    for (const response of [
      new Response("Unauthorized", { status: 401 }),
      new Response("down", { status: 503 }),
      new Response("invalid JSON"),
      Response.json({ status: "ok" }),
      Response.json({ status: "ok", workspace: "unavailable", engine: "busy" }),
    ]) {
      expect(
        await getHostStatus(
          config,
          vi.fn<typeof fetch>().mockResolvedValue(response),
        ),
      ).toBe("unavailable");
    }
    expect(
      await getHostStatus(
        config,
        vi.fn<typeof fetch>().mockRejectedValue(new Error("secret")),
      ),
    ).toBe("unavailable");
  });
});
