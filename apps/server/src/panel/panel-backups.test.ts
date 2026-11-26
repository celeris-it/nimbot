import { afterEach, beforeAll, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackups } from "../backups/service.js";
import { createPanel } from "./panel.js";
import { hashPassword } from "./panel-auth.js";
import { readPanelConfig } from "./panel-config.js";

let passwordHash: string;
const directories: string[] = [];
beforeAll(async () => {
  passwordHash = await hashPassword("test-password");
});
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), "nimbot-panel-backups-"));
  directories.push(stateDir);
  const sessions = new Map<string, number>();
  const config = readPanelConfig({ PANEL_PASSWORD_HASH: passwordHash });
  const backups = createBackups({
    stateDir,
    buildId: "test",
    maxBytes: 100000,
    pause: async () => {},
    resume: async () => {},
    activateRuntime: async () => {},
    invalidateSessions: () => sessions.clear(),
  });
  await backups.initialize();
  backups.activate();
  const app = createPanel(config, { backups }, Date.now, sessions);
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { Origin: config.origin },
    body: new URLSearchParams({ password: "test-password" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  return { app, backups, headers: { Cookie: cookie, Origin: config.origin } };
}

it("requires a session and matching Origin for backup uploads and restore", async () => {
  const { app, headers } = await fixture();
  expect((await app.request("/api/backups")).status).toBe(401);
  expect(
    (
      await app.request("/api/backups/restore", {
        method: "POST",
        headers: { Cookie: headers.Cookie },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request("/api/backups/upload", {
        method: "POST",
        headers: { Origin: headers.Origin },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await app.request("/api/backups/restore", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ id: "missing", confirm: false }),
      })
    ).status,
  ).toBe(400);
  expect(
    (await app.request("/api/backups/missing/download", { headers })).status,
  ).toBe(404);
});

it("keeps backup control available while maintenance blocks business routes and webhooks", async () => {
  const { app, backups, headers } = await fixture();
  backups.failMaintenance();
  expect((await app.request("/api/backups", { headers })).status).toBe(200);
  expect((await app.request("/api/session", { headers })).status).toBe(200);
  expect((await app.request("/api/status", { headers })).status).toBe(503);
  expect(
    (await app.request("/hooks/schedules/one", { method: "POST" })).status,
  ).toBe(503);
  expect(
    (await app.request("/api/backups/export", { method: "POST", headers }))
      .status,
  ).toBe(503);
});

it("streams uploads above the normal body limit and enforces the backup limit", async () => {
  const { app, backups, headers } = await fixture();
  const uploaded = await app.request("/api/backups/upload", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/octet-stream" },
    body: new Uint8Array(70000),
  });
  expect(uploaded.status).toBe(202);
  await backups.settled();
  expect(backups.status().operation?.status).toBe("failed");
  const oversized = await app.request("/api/backups/upload", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/octet-stream" },
    body: new Uint8Array(100001),
  });
  expect(oversized.status).toBe(413);
});
