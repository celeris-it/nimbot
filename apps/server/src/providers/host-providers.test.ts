import { expect, it, vi } from "vitest";
import { createHostProviders } from "./host-providers.js";
import { providers } from "./provider-contracts.js";

it("routes provider operations to distinct registered Hosts and strips private fields", async () => {
  const seen: string[] = [];
  const request = vi.fn<typeof fetch>(async (url, init) => {
    seen.push(String(url));
    if (String(url).endsWith("device-login"))
      return Response.json({
        id: "a".repeat(36),
        state: "awaiting_authorization",
        url: "https://auth.openai.com/codex/device",
        code: "ABCD-EFGH",
        access: "private-access",
        refresh: "private-refresh",
      });
    if (init?.method === "POST")
      return Response.json({ saved: true, key: "private-key" });
    return Response.json({
      providers: providers.map((p) => ({
        ...p,
        method: p.id === "openai" ? "api_key" : null,
        key: "private-key",
      })),
      busy: false,
      login: null,
      credential: "private",
    });
  });
  const client = createHostProviders(
    async (id) => ({ url: `http://${id}:3001`, token: `token-${id}` }),
    request,
  );
  expect(JSON.stringify(await client.status("a"))).not.toContain("private");
  await client.save("a", "openai", "key-a");
  await client.save("b", "openai", "key-b");
  await client.remove("b", "openai");
  expect(seen).toEqual([
    "http://a:3001/providers",
    "http://a:3001/providers/openai",
    "http://b:3001/providers/openai",
    "http://b:3001/providers/openai/remove",
  ]);
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    headers: { Authorization: "Bearer token-a" },
    body: JSON.stringify({ key: "key-a" }),
    redirect: "error",
  });
  expect(JSON.stringify(await client.startLogin("a"))).not.toContain("private");
});

it("rejects malformed metadata, arbitrary login links and unsafe errors", async () => {
  for (const data of [
    null,
    {},
    { providers: [], busy: false, login: null },
    {
      providers: providers.map((p) => ({ ...p, method: "device" })),
      busy: false,
      login: null,
    },
  ]) {
    const client = createHostProviders(
      async () => ({ url: "http://host", token: "secret" }),
      vi.fn<typeof fetch>(async () => Response.json(data)),
    );
    await expect(client.status("a")).rejects.toMatchObject({ status: 503 });
  }
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({
      id: "a".repeat(36),
      state: "awaiting_authorization",
      url: "https://evil.example",
      code: "ABCD-EFGH",
    }),
  );
  const client = createHostProviders(
    async () => ({ url: "http://host", token: "secret" }),
    request,
  );
  await expect(client.startLogin("a")).rejects.toMatchObject({ status: 503 });
  for (const status of [400, 404, 409, 500]) {
    request.mockResolvedValueOnce(
      new Response("private secret error", { status }),
    );
    await expect(client.save("a", "openai", "secret")).rejects.toMatchObject({
      status: status === 500 ? 503 : status,
      message: "Provider request failed",
    });
  }
  request.mockRejectedValueOnce(new Error("private-network-secret"));
  await expect(client.status("a")).rejects.toMatchObject({
    status: 503,
    message: "Provider request failed",
  });
});

it("validates provider checks and strips extra fields from the Host response", async () => {
  const entries = providers.map(({ id }) => ({
    id,
    state: "not_configured",
    checkedAt: 100,
    revision: null,
  }));
  const request = vi.fn<typeof fetch>(async () =>
    Response.json(
      entries.map((entry) => ({
        ...entry,
        token: "private-token",
        error: "private-error",
      })),
    ),
  );
  const client = createHostProviders(
    async () => ({ url: "http://host:3001", token: "host-token" }),
    request,
  );
  expect(await client.checks("a")).toEqual(entries);
  expect(request).toHaveBeenCalledWith(
    "http://host:3001/providers/checks",
    expect.objectContaining({
      method: "GET",
      headers: { Authorization: "Bearer host-token" },
    }),
  );
  request.mockResolvedValueOnce(
    Response.json(entries.map((entry) => ({ ...entry, id: "openai" }))),
  );
  await expect(client.checks("a")).rejects.toMatchObject({ status: 503 });
});
