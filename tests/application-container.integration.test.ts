import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { hashPassword } from "../apps/server/src/panel-auth.js";

const execute = promisify(execFile);
const image = process.env.NIMBOT_TEST_APPLICATION_IMAGE;

it.skipIf(!image)(
  "runs one non-root application container with private Hosts and retained data across recreation",
  async () => {
    const id = randomUUID();
    const name = `nimbot-application-${id}`;
    const volume = `${name}-data`;
    const directory = await mkdtemp(join(tmpdir(), "nimbot-application-"));
    const fixture = join(directory, "native-telegram.mjs");
    await copyFile(
      fileURLToPath(new URL("fixtures/native-telegram.mjs", import.meta.url)),
      fixture,
    );
    await chmod(fixture, 0o644);
    const docker = async (...args: string[]) =>
      (
        await execute("docker", args, { timeout: 120000, maxBuffer: 2000000 })
      ).stdout.trim();
    const password = "application-fixture-password";
    const hash = await hashPassword(password);
    let origin = "";
    let cookie = "";
    async function start() {
      await docker(
        "run",
        "-d",
        "--init",
        "--name",
        name,
        "--stop-timeout",
        "30",
        "--publish",
        "127.0.0.1::3000",
        "--mount",
        `type=volume,src=${volume},dst=/data`,
        "--mount",
        `type=bind,src=${fixture},dst=/app/tests/fixtures/native-telegram.mjs,readonly`,
        "--env",
        `PANEL_PASSWORD_HASH=${hash}`,
        "--env",
        "NODE_OPTIONS=--import=/app/tests/fixtures/native-telegram.mjs",
        image!,
      );
      const inspect = JSON.parse(await docker("inspect", name))[0];
      const bindings = inspect.NetworkSettings.Ports["3000/tcp"];
      expect(Object.keys(inspect.NetworkSettings.Ports)).toEqual(["3000/tcp"]);
      expect(bindings[0].HostIp).toBe("127.0.0.1");
      expect(inspect.Config.User).toBe("node");
      expect(
        inspect.Mounts.some((mount: { Destination: string }) =>
          mount.Destination.includes("docker.sock"),
        ),
      ).toBe(false);
      origin = `http://127.0.0.1:${bindings[0].HostPort}`;
      // Requests use the configured same-origin value; published ephemeral ports are a fixture detail.
      await expect
        .poll(
          async () =>
            fetch(`${origin}/api/status`)
              .then((response) => response.status)
              .catch(() => 0),
          { timeout: 20000 },
        )
        .toBe(401);
      const response = await fetch(`${origin}/api/login`, {
        method: "POST",
        headers: { Origin: "http://localhost:3000" },
        body: new URLSearchParams({ password }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    }
    async function get(path: string) {
      const response = await fetch(`${origin}${path}`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
      return response.json();
    }
    async function post(path: string, fields: Record<string, string>) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { Origin: "http://localhost:3000", Cookie: cookie },
        body: new URLSearchParams(fields),
      });
      expect(response.ok, await response.clone().text()).toBe(true);
      return response.json();
    }
    async function stop() {
      await docker("stop", name);
      const inspect = JSON.parse(await docker("inspect", name))[0];
      expect(inspect.State.ExitCode).toBe(0);
      await docker("rm", name);
    }
    try {
      const config = JSON.parse(await docker("image", "inspect", image!))[0]
        .Config;
      expect(config.User).toBe("node");
      expect(Object.keys(config.ExposedPorts)).toEqual(["3000/tcp"]);
      await docker("volume", "create", volume);
      await start();
      expect((await get("/api/session")).deploymentMode).toBe("docker");
      expect((await get("/api/status")).agents).toEqual([]);
      const created = await post("/api/agents", {
        name: "Developer",
        ownerId: "42",
        instructions: "",
        token: "123:fixture-token",
      });
      const agentId: string = created.agentId;
      await expect
        .poll(async () => (await get(`/api/agents/${agentId}`)).hostState, {
          timeout: 15000,
        })
        .toBe("ready");
      const check = await docker(
        "exec",
        name,
        "node",
        "--input-type=module",
        "-e",
        String.raw`
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { execFileSync } from 'node:child_process';
      if (process.getuid() !== 1000 || existsSync('/var/run/docker.sock')) throw new Error('Invalid runtime identity');
      writeFileSync('/data/agents/${agentId}/workspace/retained.txt', 'persistent workspace');
      console.log(execFileSync('opencode', ['--version'], {encoding:'utf8'}).trim());
      const { chromium } = await import('/app/apps/agent-host/node_modules/playwright/index.mjs');
      const browser = await chromium.launchPersistentContext('/data/agents/${agentId}/browser', {headless:true});
      try { const page = await browser.newPage(); await page.setContent('<title>Container browser</title>'); if (await page.title() !== 'Container browser') throw new Error('Chromium failed'); }
      finally { await browser.close(); }
      const listeners = readFileSync('/proc/net/tcp','utf8').split('\n').filter(line => line.includes(' 0A ')).map(line => line.trim().split(/\s+/)[1]);
      console.log(JSON.stringify(listeners));
    `,
      );
      expect(check).toContain("opencode v2.2.7");
      const listeners = JSON.parse(check.split("\n").at(-1)!) as string[];
      expect(listeners).toContain("00000000:0BB8");
      expect(
        listeners.filter(
          (address) =>
            !address.split(":")[0]!.endsWith("7F") &&
            address !== "00000000:0BB8",
        ),
      ).toEqual([]);
      await post(`/api/agents/${agentId}/process`, {
        action: "restart",
        confirm: agentId,
      });
      await stop();
      await start();
      await expect
        .poll(async () => (await get(`/api/agents/${agentId}`)).hostState, {
          timeout: 15000,
        })
        .toBe("ready");
      expect(
        await docker(
          "exec",
          name,
          "node",
          "-e",
          `process.stdout.write(require('node:fs').readFileSync('/data/agents/${agentId}/workspace/retained.txt','utf8'))`,
        ),
      ).toBe("persistent workspace");
      await post(`/api/agents/${agentId}/process`, {
        action: "stop",
        confirm: agentId,
      });
      expect((await get(`/api/agents/${agentId}`)).process.state).toBe(
        "stopped",
      );
      await stop();
    } finally {
      await docker("rm", "-f", name).catch(() => {});
      await docker("volume", "rm", volume).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
  150000,
);
