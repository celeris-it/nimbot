import { expect, it, vi } from "vitest";
import { createOpenCodeAuth } from "./opencode-auth.js";
import type { OpenCodeRequest } from "./opencode-api.js";

function fixture() {
  let busy = false;
  const credentials = [
    {
      id: "original",
      integrationID: "openai",
      active: true,
      value: { type: "key", key: "private" },
    },
  ];
  const attempt = { state: "pending", invalidUrl: false };
  const changed = vi.fn();
  const request = vi.fn<OpenCodeRequest>(async (path, options) => {
    if (path === "/api/credential" && !options?.body)
      return { data: [...credentials] };
    if (path === "/api/credential") {
      credentials.push({
        id: "replacement",
        integrationID: "openai",
        active: true,
        value: {
          type: "key",
          key: "new-private-key",
        },
      });
      return;
    }
    if (path.startsWith("/api/credential/") && options?.method === "DELETE") {
      credentials.splice(
        credentials.findIndex((entry) => path.endsWith(entry.id)),
        1,
      );
      return;
    }
    if (path.endsWith("/connect/oauth")) {
      return {
        data: {
          attemptID: "attempt",
          url: attempt.invalidUrl
            ? "https://example.com/unsafe"
            : path.includes("/opencode/")
              ? "https://opencode.ai/console/auth/device?code=ABCD-EFGH"
              : "https://auth.openai.com/codex/device",
          instructions: "Enter code: ABCD-EFGH",
          mode: "auto",
        },
      };
    }
    if (path.endsWith("/attempt")) {
      if (options?.method === "DELETE") return;
      return { data: { status: attempt.state } };
    }
    throw new Error("Unexpected API request");
  });
  const auth = createOpenCodeAuth(
    request,
    () => {
      if (busy) return undefined;
      busy = true;
      return () => {
        busy = false;
      };
    },
    () => busy,
    changed,
    { pollMs: 5, loginTimeoutMs: 300 },
  );
  return { auth, request, changed, credentials, attempt };
}

it("uses OpenCode's credential API and publishes only provider status", async () => {
  const { auth, credentials, changed } = fixture();
  expect(JSON.stringify(await auth.status())).not.toContain("private");
  await auth.save("openai", "new-private-key");
  expect(credentials.map(({ id }) => id)).toEqual(["replacement"]);
  expect(
    (await auth.status()).providers.find(({ id }) => id === "openai")?.method,
  ).toBe("api_key");
  await auth.remove("openai");
  expect(credentials).toEqual([]);
  expect(changed).toHaveBeenCalledTimes(2);
});

it("runs a Console login under the same exclusive reservation and supports cancellation", async () => {
  const { auth, request, credentials } = fixture();
  const login = auth.startLogin("opencode");
  expect(login.provider).toBe("opencode");
  await vi.waitFor(async () =>
    expect((await auth.status()).login?.state).toBe("awaiting_authorization"),
  );
  expect(() => auth.startLogin()).toThrow("busy");
  await expect(auth.cancelLogin(login.id)).rejects.toThrow("not_found");
  const cancelled = await auth.cancelLogin(login.id, "opencode");
  expect(cancelled.state).toBe("cancelled");
  expect(cancelled.url).toBeUndefined();
  expect(request).toHaveBeenCalledWith(
    "/api/integration/opencode/connect/oauth",
    { body: { methodID: "device" } },
  );
  expect(request).toHaveBeenCalledWith(
    "/api/integration/opencode/connect/oauth/attempt",
    { method: "DELETE" },
  );
  expect(credentials[0]?.id).toBe("original");
});

it("rejects an unrecognized authorization URL and leaves the old credential in place", async () => {
  const { auth, attempt, credentials } = fixture();
  attempt.invalidUrl = true;
  auth.startLogin();
  await vi.waitFor(async () =>
    expect((await auth.status()).login?.state).toBe("failed"),
  );
  expect(credentials[0]?.id).toBe("original");
  expect((await auth.status()).busy).toBe(false);
});

it("retires the prior credential only when OpenCode confirms login completion", async () => {
  const { auth, credentials, attempt } = fixture();
  auth.startLogin();
  await vi.waitFor(async () =>
    expect((await auth.status()).login?.state).toBe("awaiting_authorization"),
  );
  credentials.push({
    id: "device",
    integrationID: "openai",
    active: true,
    value: { type: "oauth", key: "private-token" },
  });
  attempt.state = "complete";
  await vi.waitFor(async () =>
    expect((await auth.status()).login?.state).toBe("completed"),
  );
  expect(credentials.map(({ id }) => id)).toEqual(["device"]);
  expect(JSON.stringify(await auth.status())).not.toContain("private-token");
});

it("expires a pending login, releases the reservation, and closes without exposing a code", async () => {
  const { auth, credentials } = fixture();
  auth.startLogin();
  await vi.waitFor(async () =>
    expect((await auth.status()).login?.state).toBe("expired"),
  );
  expect((await auth.status()).busy).toBe(false);
  expect((await auth.status()).login?.code).toBeUndefined();
  expect(credentials[0]?.id).toBe("original");
  await auth.close();
  expect(() => auth.startLogin()).toThrow("unavailable");
});
