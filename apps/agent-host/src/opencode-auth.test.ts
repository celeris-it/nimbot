import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOpenCodeAuth } from "./opencode-auth.js";
import { createHostApi } from "./http.js";
import { createTaskRunner } from "./tasks.js";
import { openTaskStore } from "./task-store.js";
import { pathToFileURL } from "node:url";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const fakeLogin = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const scenario = JSON.parse(fs.readFileSync(path.join(root, 'scenario.json'), 'utf8'));
const expected = ['auth','login','--provider','openai','--method','ChatGPT Pro/Plus (headless)','--pure'];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected) || process.env.OPENCODE_AUTH_CONTENT) process.exit(12);
process.stdout.write('\\x1b[32mGo to: https://auth.openai.com/codex/device\\x1b[0m\\n');
process.stderr.write('Enter co');
setTimeout(() => process.stderr.write('de: ABCD-'), 10);
setTimeout(() => process.stderr.write('EFGH\\n'), 20);
if (scenario.mode === 'fail') setTimeout(() => { process.stderr.write('private-refresh-token /secret/path'); process.exit(1); }, 30);
else if (scenario.mode === 'empty') setTimeout(() => process.exit(0), 30);
else {
 const timer = setInterval(() => {
  if (!fs.existsSync(path.join(root,'approve'))) return;
  clearInterval(timer);
  const dir = path.join(process.env.XDG_DATA_HOME, 'opencode');
  fs.mkdirSync(dir, {recursive:true, mode:0o700});
  const credential = scenario.mode === 'invalid' ? {type:'oauth', refresh:'bad'} : {type:'oauth', access:'private-access-token', refresh:'private-refresh-token', expires:Date.now()+3600000, accountId:'account-a'};
  fs.writeFileSync(path.join(dir,'auth.json'), JSON.stringify({openai:credential}), {mode:0o600});
  process.exit(0);
 }, 5);
}
`;
async function setup(mode = "success", timeout = 5000) {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-auth-test-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, "opencode");
  await writeFile(executable, fakeLogin, { mode: 0o755 });
  await writeFile(join(dir, "scenario.json"), JSON.stringify({ mode }));
  const temp = join(dir, "temporary");
  await mkdir(temp);
  const store = await openTaskStore(
    pathToFileURL(join(dir, "tasks.sqlite")).href,
  );
  cleanup.push(async () => store.close());
  let finishTask: (() => void) | undefined;
  const runner = createTaskRunner(store, {
    run: async () => {
      await new Promise<void>((resolve) => {
        finishTask = resolve;
      });
      return "end_turn";
    },
    stop: async () => {
      finishTask?.();
    },
  });
  cleanup.push(() => runner.close());
  const directory = join(dir, "engine");
  const auth = await createOpenCodeAuth(
    directory,
    runner.reserve,
    runner.isBusy,
    { executable, temporaryRoot: temp, loginTimeoutMs: timeout },
  );
  cleanup.push(() => auth.close());
  const token = "a".repeat(64);
  const app = createHostApi({ token, workspace: dir }, runner, auth);
  const request = (
    path: string,
    body?: unknown,
    authorization = `Bearer ${token}`,
  ) =>
    app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    dir,
    auth,
    runner,
    store,
    request,
    directory,
    temp,
    approve: () => writeFile(join(dir, "approve"), "yes"),
    finish: () => finishTask?.(),
  };
}
async function waitFor(
  auth: Awaited<ReturnType<typeof createOpenCodeAuth>>,
  state: string,
) {
  await vi.waitFor(
    async () => expect((await auth.status()).login?.state).toBe(state),
    { timeout: 4000, interval: 10 },
  );
}

it("stores independent private credentials for two agents and never returns them in metadata", async () => {
  const a = await setup();
  const b = await setup();
  await a.auth.save("openai", "private-a");
  await a.auth.save("google", "private-google");
  await b.auth.save("openai", "private-b");
  expect((await stat(a.directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(a.directory, "auth.json"))).mode & 0o777).toBe(0o600);
  const reopened = await createOpenCodeAuth(
    a.directory,
    a.runner.reserve,
    a.runner.isBusy,
  );
  expect((await reopened.status()).providers[0]?.method).toBe("api_key");
  await a.auth.remove("openai");
  expect(
    JSON.parse(await readFile(join(a.directory, "auth.json"), "utf8")),
  ).toEqual({ google: { type: "api", key: "private-google" } });
  expect(
    JSON.parse(await readFile(join(b.directory, "auth.json"), "utf8")),
  ).toEqual({ openai: { type: "api", key: "private-b" } });
  expect(JSON.stringify(await b.auth.status())).not.toContain("private-b");
  await writeFile(join(a.directory, "auth.json"), "malformed");
  await expect(a.auth.status()).rejects.toMatchObject({ kind: "unavailable" });
  await expect(a.auth.save("openai", "replacement")).rejects.toMatchObject({
    kind: "unavailable",
  });
});

it("completes headless login from fragmented ANSI output and replaces only this agent's OpenAI credential", async () => {
  const a = await setup();
  const b = await setup();
  await a.auth.save("openai", "previous");
  await a.auth.save("anthropic", "other-provider");
  await b.auth.save("openai", "other-agent");
  vi.stubEnv("OPENCODE_AUTH_CONTENT", "must-not-inherit");
  const started = a.auth.startLogin();
  expect(started.state).toBe("starting");
  expect(a.runner.isBusy()).toBe(true);
  await waitFor(a.auth, "awaiting_authorization");
  expect((await a.auth.status()).login).toEqual({
    id: started.id,
    state: "awaiting_authorization",
    url: "https://auth.openai.com/codex/device",
    code: "ABCD-EFGH",
  });
  expect(await a.runner.submit("not executed")).toBeUndefined();
  await expect(a.auth.save("google", "blocked")).rejects.toMatchObject({
    kind: "busy",
  });
  expect(() => a.auth.startLogin()).toThrow("busy");
  await expect(b.auth.cancelLogin(started.id)).rejects.toMatchObject({
    kind: "not_found",
  });
  await a.approve();
  await waitFor(a.auth, "completed");
  expect(a.runner.isBusy()).toBe(false);
  expect(await readdir(a.temp)).toEqual([]);
  const status = await a.auth.status();
  expect(status.providers[0]?.method).toBe("device");
  expect(JSON.stringify(status)).not.toMatch(/private-|ABCD|account-a/);
  const data = JSON.parse(
    await readFile(join(a.directory, "auth.json"), "utf8"),
  );
  expect(data.openai.refresh).toBe("private-refresh-token");
  expect(data.anthropic.key).toBe("other-provider");
  expect(
    JSON.parse(await readFile(join(b.directory, "auth.json"), "utf8")),
  ).toEqual({ openai: { type: "api", key: "other-agent" } });
  await a.auth.save("openai", "back-to-api");
  expect((await a.auth.status()).providers[0]?.method).toBe("api_key");
});

it.each(["fail", "empty", "invalid"])(
  "preserves previous credentials after %s login and permits retry",
  async (mode) => {
    const f = await setup(mode);
    await f.auth.save("openai", "previous");
    f.auth.startLogin();
    if (mode === "invalid") await f.approve();
    await waitFor(f.auth, "failed");
    expect(f.runner.isBusy()).toBe(false);
    expect(await readdir(f.temp)).toEqual([]);
    expect(JSON.stringify(await f.auth.status())).not.toMatch(
      /private-|secret\/path/,
    );
    expect(
      JSON.parse(await readFile(join(f.directory, "auth.json"), "utf8")),
    ).toEqual({ openai: { type: "api", key: "previous" } });
    await f.auth.save("google", "allowed");
  },
);

it("cancels only the matching attempt, cleans temporary secrets and survives a Host restart", async () => {
  const f = await setup();
  await f.auth.save("openai", "previous");
  const first = f.auth.startLogin();
  await waitFor(f.auth, "awaiting_authorization");
  await expect(f.auth.cancelLogin("b".repeat(36))).rejects.toMatchObject({
    kind: "not_found",
  });
  expect((await f.auth.cancelLogin(first.id)).state).toBe("cancelled");
  const second = f.auth.startLogin();
  expect(second.id).not.toBe(first.id);
  await expect(f.auth.cancelLogin(first.id)).rejects.toMatchObject({
    kind: "not_found",
  });
  await f.auth.close();
  expect((await f.auth.status()).login?.state).toBe("cancelled");
  expect(await readdir(f.temp)).toEqual([]);
  const reopened = await createOpenCodeAuth(
    f.directory,
    f.runner.reserve,
    f.runner.isBusy,
  );
  expect((await reopened.status()).login).toBeNull();
  expect((await reopened.status()).providers[0]?.method).toBe("api_key");
});

it("expires the local login deadline and releases the agent", async () => {
  const f = await setup("success", 100);
  f.auth.startLogin();
  await waitFor(f.auth, "expired");
  expect(f.runner.isBusy()).toBe(false);
  expect(await readdir(f.temp)).toEqual([]);
});

it("blocks authentication throughout a task and protects every Host operation", async () => {
  const f = await setup();
  const task = await f.runner.submit("working");
  for (const suffix of ["openai", "openai/remove", "openai/device-login"])
    expect(
      (await f.request(`/providers/${suffix}`, { key: "private-key" })).status,
    ).toBe(409);
  expect(
    (await f.request("/providers", undefined, "Bearer wrong")).status,
  ).toBe(401);
  expect(
    (await f.request("/providers/openai/device-login", {}, "Bearer wrong"))
      .status,
  ).toBe(401);
  f.finish();
  await vi.waitFor(() => expect(f.runner.isBusy()).toBe(false));
  expect((await f.store.get(task!))?.status).toBe("completed");
  expect((await f.request("/providers/openai", { key: "" })).status).toBe(400);
  expect(
    (await f.request("/providers/unknown", { key: "secret" })).status,
  ).toBe(400);
  expect(
    (await f.request("/providers/openai", { key: "x".repeat(20000) })).status,
  ).toBe(413);
  expect(
    (await f.request("/providers/openai", { key: "private-key" })).status,
  ).toBe(200);
  const metadata = await f.request("/providers");
  expect(metadata.headers.get("cache-control")).toBe("no-store");
  expect(await metadata.text()).not.toContain("private-key");
  await chmod(join(f.directory, "auth.json"), 0o644);
  expect((await f.request("/providers")).status).toBe(503);
});

it("releases the lock when the login executable cannot start", async () => {
  const f = await setup();
  const missing = await createOpenCodeAuth(
    f.directory,
    f.runner.reserve,
    f.runner.isBusy,
    { executable: join(f.dir, "missing"), temporaryRoot: f.temp },
  );
  missing.startLogin();
  await waitFor(missing, "failed");
  expect(f.runner.isBusy()).toBe(false);
  expect(await readdir(f.temp)).toEqual([]);
  await f.auth.save("openai", "still-usable");
  await missing.close();
});
