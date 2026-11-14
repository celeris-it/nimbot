import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostApi, readHostConfig } from "./http.js";

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
