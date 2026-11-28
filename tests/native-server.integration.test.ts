import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { promisify } from "node:util";
const execute = promisify(execFile);

/** Run after pnpm build: NIMBOT_TEST_NATIVE_BUILD=1 pnpm test tests/native-server.integration.test.ts */
it.skipIf(process.env.NIMBOT_TEST_NATIVE_BUILD !== "1")(
  "runs native Server lifecycle and restart recovery through the authenticated panel API",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "nimbot-native-server-"));
    const root = fileURLToPath(new URL("../", import.meta.url));
    const password = "fixture-password";
    let child: ChildProcess | undefined;
    let origin = "";
    let cookie = "";
    let output = "";
    let firstBoot = true;
    async function start() {
      const reservation = createServer();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      const address = reservation.address();
      if (!address || typeof address === "string")
        throw new Error("No test port");
      const port = address.port;
      await new Promise<void>((done) => reservation.close(() => done()));
      origin = `http://127.0.0.1:${port}`;
      const bootstrap = firstBoot;
      firstBoot = false;
      child = spawn(
        process.execPath,
        [
          join(
            root,
            bootstrap ? "scripts/dev.mjs" : "apps/server/dist/index.js",
          ),
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            NODE_OPTIONS: `--import=${join(root, "tests/fixtures/native-telegram.mjs")}`,
            NIMBOT_MODE: bootstrap ? "docker" : "native",
            SERVER_STATE_DIR: directory,
            PANEL_HOST: "127.0.0.1",
            PANEL_PORT: String(port),
            PANEL_URL: origin,
            // Native startup must ignore all previous per-agent Docker settings.
            DOCKER_SOCKET_PATH: "/missing/docker.sock",
            AGENT_HOST_IMAGE: "invalid image",
            SERVER_CONTAINER_NAME: "invalid container",
            NIMBOT_UPGRADE_TOKEN: "obsolete-activation-token",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout?.on("data", (bytes) => {
        output = (output + bytes).slice(-8000);
      });
      child.stderr?.on("data", (bytes) => {
        output = (output + bytes).slice(-8000);
      });
      await expect
        .poll(
          async () => {
            if (child?.exitCode !== null)
              throw new Error(`Server exited: ${output}`);
            return fetch(`${origin}/api/status`)
              .then((response) => response.status)
              .catch(() => 0);
          },
          { timeout: 15000 },
        )
        .toBe(401);
      await expect
        .poll(
          async () => fetch(`${origin}/api/auth/status`).then((r) => r.status),
          { timeout: 15000 },
        )
        .toBe(200);
      const authentication = await (
        await fetch(`${origin}/api/auth/status`)
      ).json();
      if (bootstrap) {
        expect(authentication.setupRequired).toBe(true);
        const { stdout } = await execute(
          process.execPath,
          [join(root, "apps/server/dist/setup-link.js")],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              NIMBOT_MODE: "native",
              SERVER_STATE_DIR: directory,
              PANEL_URL: origin,
              PANEL_PORT: String(port),
            },
          },
        );
        const link = new URL(stdout.trim());
        expect(link.origin).toBe(origin);
        const token = new URLSearchParams(link.hash.slice(1)).get("token")!;
        const setup = await fetch(`${origin}/api/auth/setup`, {
          method: "POST",
          headers: { Origin: origin },
          body: new URLSearchParams({
            token,
            password,
            confirmation: password,
          }),
        });
        expect(setup.status).toBe(200);
        expect(output).not.toContain(token);
        expect(output).not.toContain(password);
      } else expect(authentication.setupRequired).toBe(false);
      const login = await fetch(`${origin}/api/login`, {
        method: "POST",
        headers: { Origin: origin },
        body: new URLSearchParams({ password }),
      });
      expect(login.status).toBe(200);
      cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    }
    async function stop() {
      if (!child || child.exitCode !== null || child.signalCode !== null)
        return;
      const exiting = once(child, "exit");
      const timer = setTimeout(() => child?.kill("SIGKILL"), 10000);
      child.kill("SIGTERM");
      try {
        const [code] = await exiting;
        expect(code, output).toBe(0);
      } finally {
        clearTimeout(timer);
      }
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
        headers: { Cookie: cookie, Origin: origin },
        body: new URLSearchParams(fields),
      });
      expect(response.ok, await response.clone().text()).toBe(true);
      return response.json();
    }
    try {
      await start();
      expect((await get("/api/status")).agents).toEqual([]);
      const first = await post("/api/agents", {
        name: "First",
        instructions: "Be brief",
      });
      const id: string = first.agentId;
      await expect
        .poll(async () => (await get(`/api/agents/${id}`)).hostState)
        .toBe("ready");
      const file = join(directory, "agents", id, "workspace", "retained.txt");
      await writeFile(file, "persistent workspace");
      const runtimeDirectories = [
        join(directory, "agents", id, "tmp"),
        join(directory, "agents", id, "engine", "cache"),
      ];
      for (const path of runtimeDirectories)
        await writeFile(
          join(path, "backup-exclusion-marker"),
          "disposable runtime content",
        );
      // Exercise maintenance and reopen with an actual running Agent Host.
      const exported = await post("/api/backups/export", {});
      await expect
        .poll(async () => (await get("/api/backups")).operation.status, {
          timeout: 20000,
        })
        .toBe("ready");
      const downloaded = await fetch(
        `${origin}/api/backups/${exported.id}/download`,
        { headers: { Cookie: cookie } },
      );
      expect(downloaded.status).toBe(200);
      const archive = await downloaded.arrayBuffer();
      expect((await get(`/api/agents/${id}`)).hostState).toBe("ready");
      await writeFile(file, "changed after export");
      const uploaded = await fetch(`${origin}/api/backups/upload`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/octet-stream",
        },
        body: archive,
      });
      expect(uploaded.status).toBe(202);
      const validated = await uploaded.json();
      await expect
        .poll(async () => (await get("/api/backups")).operation.status, {
          timeout: 20000,
        })
        .toBe("ready");
      const restoring = await fetch(`${origin}/api/backups/restore`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: validated.id, confirm: true }),
      });
      expect(restoring.status).toBe(202);
      await expect
        .poll(
          async () =>
            (
              await fetch(`${origin}/api/backups`, {
                headers: { Cookie: cookie },
              })
            ).status,
          { timeout: 20000 },
        )
        .toBe(401);
      const signedIn = await fetch(`${origin}/api/login`, {
        method: "POST",
        headers: { Origin: origin },
        body: new URLSearchParams({ password }),
      });
      expect(signedIn.status).toBe(200);
      cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
      expect(await readFile(file, "utf8")).toBe("persistent workspace");
      expect((await get(`/api/agents/${id}`)).hostState).toBe("ready");
      for (const path of runtimeDirectories) {
        expect((await stat(path)).isDirectory()).toBe(true);
        await expect(
          stat(join(path, "backup-exclusion-marker")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      await post(`/api/agents/${id}/process`, {
        action: "stop",
        confirm: id,
      });
      expect((await get(`/api/agents/${id}`)).hostState).toBe("unavailable");
      await stop();
      await start();
      expect((await get(`/api/agents/${id}`)).provisioning).toBe("pending");
      await post(`/api/agents/${id}/process`, { action: "start" });
      await post(`/api/agents/${id}/process`, {
        action: "restart",
        confirm: id,
      });
      expect((await get(`/api/agents/${id}`)).process.state).toBe("running");
      await stop();
      await start();
      await expect
        .poll(async () => (await get(`/api/agents/${id}`)).hostState, {
          timeout: 15000,
        })
        .toBe("ready");
      expect(await readFile(file, "utf8")).toBe("persistent workspace");
      expect(await get(`/api/agents/${id}`)).toMatchObject({
        botUsername: null,
        botConnection: { status: "not_started" },
        capabilities: { connectTelegram: true, replaceToken: false },
      });
      await post(`/api/agents/${id}/telegram`, {
        ownerId: "42",
        token: "123:fixture-token",
      });
      await expect
        .poll(async () => (await get(`/api/agents/${id}`)).botConnection.status)
        .toBe("polling");
      const second = await post("/api/agents", {
        name: "Second",
        instructions: "",
        ownerId: "42",
        token: "456:fixture-token",
      });
      expect((await get(`/api/agents/${second.agentId}`)).hostState).toBe(
        "ready",
      );
      await post(`/api/agents/${id}/delete`, {
        confirm: id,
        deleteData: "false",
      });
      expect(await readFile(file, "utf8")).toBe("persistent workspace");
      expect(
        (await get("/api/status")).agents.map(
          (agent: { id: string }) => agent.id,
        ),
      ).toEqual([second.agentId]);
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);
