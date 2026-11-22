import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openAgentGrants } from "./peers/agent-grants.js";
import { createPanel } from "./panel.js";
import { hashPassword } from "./panel-auth.js";
import { readPanelConfig } from "./panel-config.js";

it("manages peer grants per source agent with session, Origin and ownership checks", async () => {
  const owners: Record<string, number> = { a: 1, b: 1, c: 2 };
  const grants = openAgentGrants(
    join(mkdtempSync(join(tmpdir(), "pp-")), "s.sqlite"),
    {
      exists: (id) => id in owners,
      telegramOwner: (id) => owners[id],
      discordOwner: () => undefined,
    },
  );
  const config = readPanelConfig({
    PANEL_PASSWORD_HASH: await hashPassword("test-password"),
  });
  const app = createPanel(config, {
    peers: {
      grants,
      candidates: (id) =>
        Object.keys(owners)
          .filter((o) => o !== id && owners[o] === owners[id])
          .map((o) => ({ id: o, name: o })),
    },
    getAgentSetup: (id) =>
      id in owners
        ? { name: id, botUsername: null, provisioning: "ready" }
        : undefined,
  });
  expect((await app.request("/api/agents/a/peers")).status).toBe(401);
  const login = await app.request("/api/login", {
    method: "POST",
    headers: {
      Origin: config.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "password=test-password",
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const post = (path: string, body: string, origin = config.origin) =>
    app.request(path, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  const list = async (id: string) =>
    (await (
      await app.request(`/api/agents/${id}/peers`, {
        headers: { Cookie: cookie },
      })
    ).json()) as {
      grants: unknown[];
      candidates: { id: string }[];
    };
  expect((await list("a")).candidates).toEqual([{ id: "b", name: "b" }]);
  expect(
    (
      await post(
        "/api/agents/a/peers/grant",
        "target=b&permission=note",
        "https://evil.example",
      )
    ).status,
  ).toBe(403);
  expect(
    (await post("/api/agents/zzz/peers/grant", "target=b&permission=note"))
      .status,
  ).toBe(404);
  expect(
    (await post("/api/agents/a/peers/grant", "target=b&permission=admin"))
      .status,
  ).toBe(400);
  expect(
    (await post("/api/agents/a/peers/grant", "target=a&permission=note"))
      .status,
  ).toBe(400);
  expect(
    (await post("/api/agents/a/peers/grant", "target=c&permission=note"))
      .status,
  ).toBe(400);
  expect((await list("a")).grants).toEqual([]);
  expect(
    (await post("/api/agents/a/peers/grant", "target=b&permission=delegate"))
      .status,
  ).toBe(201);
  expect((await list("a")).grants).toHaveLength(1);
  expect((await list("b")).grants).toEqual([]);
  expect(
    (await post("/api/agents/b/peers/revoke", "target=a&permission=delegate"))
      .status,
  ).toBe(404);
  expect(
    (await post("/api/agents/a/peers/revoke", "target=b&permission=delegate"))
      .status,
  ).toBe(200);
  expect((await list("a")).grants).toEqual([]);
});
