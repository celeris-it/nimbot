import { afterEach, expect, it } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPanelAuthentication,
  environmentPasswordHash,
} from "./panel-authentication.js";
import { hashPassword, verifyPassword } from "./panel-auth.js";
import { readPanelConfig } from "./panel-config.js";
import { createPanel } from "./panel.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-auth-"));
  directories.push(dir);
  const auth = createPanelAuthentication(dir);
  await auth.reload();
  let clock = 0;
  const config = readPanelConfig({});
  const sessions = new Map<string, number>();
  const app = createPanel(
    config,
    { authentication: auth },
    () => clock,
    sessions,
  );
  const recovery = createPanel(
    config,
    { authentication: auth },
    () => clock,
    sessions,
  );
  const tokenPath = join(dir, "panel-auth", "setup-token");
  const hashPath = join(dir, "panel-auth", "password-hash");
  const token = await readFile(tokenPath, "utf8");
  const password = "new administrator password";
  function setup(
    fields: Record<string, string> = {},
    target = app,
    origin = config.origin,
  ) {
    return target.request("/api/auth/setup", {
      method: "POST",
      headers: { Origin: origin },
      body: new URLSearchParams({
        token,
        password,
        confirmation: password,
        ...fields,
      }),
    });
  }
  const login = (value = password, target = app) =>
    target.request("/api/login", {
      method: "POST",
      headers: { Origin: config.origin },
      body: new URLSearchParams({ password: value }),
    });
  return {
    dir,
    auth,
    config,
    app,
    recovery,
    token,
    tokenPath,
    hashPath,
    password,
    setup,
    login,
    advance: () => {
      clock += 15 * 60_000;
    },
  };
}

it("creates a password once, persists only a private hash and signs in", async () => {
  const f = await fixture();
  expect(await (await f.app.request("/api/auth/status")).json()).toEqual({
    setupRequired: true,
  });
  expect((await f.app.request("/api/status")).status).toBe(401);
  expect((await f.login()).status).toBe(409);
  const response = await f.setup();
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  expect(
    (await f.app.request("/api/session", { headers: { Cookie: cookie } }))
      .status,
  ).toBe(200);
  const saved = await readFile(f.hashPath, "utf8");
  expect(saved).not.toContain(f.password);
  expect(await verifyPassword(f.password, saved)).toBe(true);
  expect((await stat(f.hashPath)).mode & 0o777).toBe(0o600);
  expect((await stat(join(f.dir, "panel-auth"))).mode & 0o777).toBe(0o700);
  await expect(readFile(f.tokenPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await f.setup()).status).toBe(409);
  expect((await f.login()).status).toBe(200);
  expect((await f.login("wrong")).status).toBe(401);
  const restarted = createPanelAuthentication(f.dir);
  await restarted.reload();
  expect(restarted.pending).toBe(false);
  expect(await restarted.verify(f.password)).toBe(true);
});

it("shares activation and authentication with the recovery panel", async () => {
  const f = await fixture();
  expect((await f.setup({}, f.recovery)).status).toBe(200);
  expect((await f.setup()).status).toBe(409);
  expect((await f.login()).status).toBe(200);
  expect((await f.login(f.password, f.recovery)).status).toBe(200);
});

it.each<Record<string, string>>([
  { token: "" },
  { token: "x".repeat(64) },
  { token: "a".repeat(64) },
  { password: "short", confirmation: "short" },
  { confirmation: "different" },
  { password: "x".repeat(257), confirmation: "x".repeat(257) },
])("rejects invalid setup fields without saving: %j", async (fields) => {
  const f = await fixture();
  expect([400, 403]).toContain((await f.setup(fields)).status);
  await expect(readFile(f.hashPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await f.setup()).status).toBe(200);
});

it("enforces origin, body size, rate limits across both panels and reset time", async () => {
  const f = await fixture();
  expect((await f.setup({}, f.app, "https://foreign.test")).status).toBe(403);
  expect((await f.setup({ password: "x".repeat(5000) })).status).toBe(413);
  for (let i = 0; i < 5; i++)
    expect(
      (await f.setup({ token: "bad" }, i % 2 ? f.app : f.recovery)).status,
    ).toBe(403);
  const limited = await f.setup();
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("900");
  f.advance();
  expect((await f.setup()).status).toBe(200);
});

it("allows only one concurrent activation", async () => {
  const f = await fixture();
  const responses = await Promise.all([f.setup(), f.setup({}, f.recovery)]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
});

it("rotates unfinished activation tokens on reload", async () => {
  const f = await fixture();
  await f.auth.reload();
  const token = await readFile(f.tokenPath, "utf8");
  expect(token).not.toBe(f.token);
  expect((await f.setup()).status).toBe(403);
  expect((await f.setup({ token })).status).toBe(200);
});

it("fails closed on invalid, empty or public saved state", async () => {
  const f = await fixture();
  for (const value of ["", "invalid-hash"]) {
    await writeFile(f.hashPath, value, { mode: 0o600 });
    await expect(f.auth.reload()).rejects.toThrow(
      "saved panel password hash is invalid",
    );
    expect(f.auth.ready).toBe(false);
    expect((await f.app.request("/api/auth/status")).status).toBe(503);
    expect((await f.login()).status).toBe(503);
  }
  await writeFile(f.hashPath, await hashPassword(f.password));
  await chmod(f.hashPath, 0o644);
  await expect(f.auth.reload()).rejects.toThrow("private regular files");
});

it("retains pending setup and permits retry after a failed atomic publication", async () => {
  const f = await fixture();
  // An unexpected existing destination must never be overwritten.
  await mkdir(f.hashPath);
  expect((await f.setup()).status).toBe(503);
  expect(f.auth.pending).toBe(true);
  expect(await readFile(f.tokenPath, "utf8")).toBe(f.token);
  await rm(f.hashPath, { recursive: true });
  expect((await f.setup()).status).toBe(200);
});

it("reloads a restored password for both panels and keeps the environment authoritative", async () => {
  const f = await fixture();
  await f.setup();
  await writeFile(f.hashPath, await hashPassword("restored-password"));
  await f.auth.reload();
  expect((await f.login()).status).toBe(401);
  expect((await f.login("restored-password", f.recovery)).status).toBe(200);
  const envHash = await hashPassword("environment-password");
  const overridden = createPanelAuthentication(f.dir, envHash);
  await overridden.reload();
  expect(await overridden.verify("environment-password")).toBe(true);
  const restored = createPanelAuthentication(f.dir);
  await restored.reload();
  expect(await restored.verify("restored-password")).toBe(true);
});

it("resolves environment credentials with hash priority and validates them", async () => {
  const hash = await hashPassword("hashed-password");
  expect(
    await environmentPasswordHash({
      PANEL_PASSWORD_HASH: hash,
      PANEL_PASSWORD: "short",
    }),
  ).toBe(hash);
  expect(
    await verifyPassword(
      "plaintext-password",
      await environmentPasswordHash({ PANEL_PASSWORD: "plaintext-password" }),
    ),
  ).toBe(true);
  expect(
    await environmentPasswordHash({
      PANEL_PASSWORD_HASH: "",
      PANEL_PASSWORD: "",
    }),
  ).toBe("");
  await expect(
    environmentPasswordHash({
      PANEL_PASSWORD_HASH: "bad",
      PANEL_PASSWORD: "valid-password",
    }),
  ).rejects.toThrow("PANEL_PASSWORD_HASH");
  await expect(
    environmentPasswordHash({ PANEL_PASSWORD: "short" }),
  ).rejects.toThrow("PANEL_PASSWORD");
});

it("uses secure session cookies for HTTPS activation", async () => {
  const f = await fixture();
  const origin = "https://panel.test";
  const app = createPanel({ ...f.config, origin }, { authentication: f.auth });
  const response = await f.setup({}, app, origin);
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("Secure");
});
