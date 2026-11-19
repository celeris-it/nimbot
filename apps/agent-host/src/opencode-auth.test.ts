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
  const providerFetch = vi.fn<typeof fetch>(
    async () => new Response(null, { status: 200 }),
  );
  let needsAuth = false;
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
    if (path === "/api/integration/openai") {
      return {
        data: {
          connections: [
            {
              type: "credential",
              id: "device",
              ...(needsAuth
                ? { status: { status: "needs_auth", message: "private" } }
                : {}),
            },
          ],
        },
      };
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
    { pollMs: 5, loginTimeoutMs: 300, fetch: providerFetch },
  );
  return {
    auth,
    request,
    changed,
    credentials,
    attempt,
    providerFetch,
    requireReauthentication() {
      needsAuth = true;
    },
  };
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

it("preserves the active credential when validation fails or the provider is unavailable", async () => {
  const { auth, credentials, providerFetch, request, changed } = fixture();
  providerFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(auth.save("openai", "candidate")).rejects.toMatchObject({
    kind: "rejected",
  });
  providerFetch.mockRejectedValueOnce(
    new DOMException("Private response", "TimeoutError"),
  );
  await expect(auth.save("openai", "candidate")).rejects.toMatchObject({
    kind: "check_unavailable",
  });
  providerFetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(auth.save("openai", "candidate")).rejects.toMatchObject({
    kind: "restricted",
  });
  providerFetch.mockResolvedValueOnce(new Response(null, { status: 429 }));
  await expect(auth.save("openai", "candidate")).rejects.toMatchObject({
    kind: "rate_limited",
  });
  expect(credentials.map(({ id }) => id)).toEqual(["original"]);
  expect(request).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it("checks saved API keys at most every five minutes and invalidates the cache after changes", async () => {
  const { auth, providerFetch } = fixture();
  const now = vi.spyOn(Date, "now");
  try {
    const first = Date.now();
    now.mockReturnValue(first);
    expect((await auth.checkProviders())[0]).toMatchObject({
      state: "available",
      checkedAt: first,
    });
    expect((await auth.checkProviders())[0]).toMatchObject({
      state: "available",
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    now.mockReturnValue(first + 300_000);
    providerFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const rejected = (await auth.checkProviders())[0];
    expect(rejected).toMatchObject({
      state: "rejected",
      checkedAt: first + 300_000,
    });
    await auth.save("openai", "new-private-key");
    const updated = (await auth.checkProviders())[0];
    expect(updated?.state).toBe("available");
    expect(updated?.revision).not.toBe(rejected?.revision);
    expect(JSON.stringify(updated)).not.toContain("private");
  } finally {
    now.mockRestore();
  }
});

it("uses an explicit OpenCode reauthentication state for the active OAuth connection", async () => {
  const { auth, credentials, providerFetch, requireReauthentication } =
    fixture();
  credentials[0] = {
    id: "device",
    active: true,
    integrationID: "openai",
    value: { type: "oauth", key: "private-token" },
  };
  const now = vi.spyOn(Date, "now");
  try {
    const first = Date.now();
    now.mockReturnValue(first);
    expect((await auth.checkProviders())[0]?.state).toBe("unverified");
    requireReauthentication();
    now.mockReturnValue(first + 300_000);
    const checks = await auth.checkProviders();
    expect(checks[0]?.state).toBe("rejected");
    expect(JSON.stringify(checks)).not.toContain("private");
    expect(providerFetch).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
  }
});
