import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openApprovalRules } from "../approvals/approval-rules.js";
import { openApprovalStore } from "../approvals/approval-store.js";
import { createPanel } from "./panel.js";
import { hashPassword } from "./panel-auth.js";
import { readPanelConfig } from "./panel-config.js";

it("manages rules and shows history per agent, with session, Origin and validation checks", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "pa-")), "s.sqlite");
  const history = openApprovalStore(path);
  const rules = openApprovalRules(path, (a) => a.endsWith(".read"));
  const config = readPanelConfig({
    PANEL_PASSWORD_HASH: await hashPassword("test-password"),
  });
  const app = createPanel(config, {
    approvals: { rules, history },
    getAgentSetup: (id) =>
      ["a", "b"].includes(id)
        ? { name: id, botUsername: null, provisioning: "ready" }
        : undefined,
  });
  expect((await app.request("/api/agents/a/approvals/rules")).status).toBe(401);
  const login = await app.request("/api/login", {
    method: "POST",
    headers: {
      Origin: config.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "password=test-password",
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const post = (path: string, body = "", origin = config.origin) =>
    app.request(path, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  const get = (path: string) =>
    app.request(path, { headers: { Cookie: cookie } });
  const form = (over: Record<string, string> = {}) =>
    new URLSearchParams({
      actionType: "mcp.docs.write",
      target: "docs/1",
      effect: "deny",
      ttlDays: "",
      ...over,
    }).toString();
  expect(
    (
      await post(
        "/api/agents/a/approvals/rules",
        form(),
        "https://evil.example",
      )
    ).status,
  ).toBe(403);
  expect((await post("/api/agents/zzz/approvals/rules", form())).status).toBe(
    404,
  );
  expect(
    (await post("/api/agents/a/approvals/rules", form({ effect: "x" }))).status,
  ).toBe(400);
  expect(
    (await post("/api/agents/a/approvals/rules", form({ ttlDays: "9999" })))
      .status,
  ).toBe(400);
  const rejected = await post(
    "/api/agents/a/approvals/rules",
    form({ effect: "allow" }),
  );
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toEqual({
    error: "Always allow is only available for read-only actions",
  });
  const created = await post(
    "/api/agents/a/approvals/rules",
    form({ ttlDays: "7" }),
  );
  expect(created.status).toBe(201);
  const rule = (await created.json()) as { id: string; expiresAt: number };
  expect(rule.expiresAt).toBeGreaterThan(Date.now());
  expect(
    (
      (await (await get("/api/agents/a/approvals/rules")).json()) as {
        rules: unknown[];
      }
    ).rules,
  ).toHaveLength(1);
  expect(
    (
      (await (await get("/api/agents/b/approvals/rules")).json()) as {
        rules: unknown[];
      }
    ).rules,
  ).toHaveLength(0);
  expect(
    (await post(`/api/agents/b/approvals/rules/${rule.id}/revoke`)).status,
  ).toBe(404);
  expect(
    (await post(`/api/agents/a/approvals/rules/${rule.id}/revoke`)).status,
  ).toBe(200);
  expect(rules.evaluate("a", "mcp.docs.write", "docs/1").decision).toBe("ask");
  history.create({
    agentId: "a",
    taskId: "t",
    origin: "telegram:1:2",
    actor: "owner",
    actionType: "mcp.docs.write",
    target: "docs/1",
    summary: "token=abc12345",
    arguments: {},
    ttlMs: 1000,
  });
  const listed = (await (await get("/api/agents/a/approvals")).json()) as {
    requests: { summary: string }[];
  };
  expect(listed.requests).toHaveLength(1);
  expect(listed.requests[0]!.summary).not.toContain("abc12345");
  expect(
    (
      (await (await get("/api/agents/b/approvals")).json()) as {
        requests: unknown[];
      }
    ).requests,
  ).toHaveLength(0);
});
