import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { browserCommand } from "../apps/agent-host/src/engine-notes.js";
import { prepareAgentProcess } from "../apps/server/src/agent-process-config.js";

const execute = promisify(execFile);

/** Run after pnpm build and installing Chromium; exercises the production browser CLI. */
it.skipIf(process.env.NIMBOT_TEST_NATIVE_BROWSER !== "1")(
  "persists separate browser profiles across concurrent agent probes and quotes native executable paths",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "nimbot-browser-"));
    const barrier: { response: ServerResponse; html: string }[] = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url!, "http://localhost");
      if (url.pathname !== "/state") {
        response.writeHead(404).end();
        return;
      }
      const value = url.searchParams.get("set");
      const html = `<html><head><title>Profile fixture</title></head><body><script>
      ${value ? `localStorage.setItem('owner', ${JSON.stringify(value)}); document.cookie = 'owner=${value}; Max-Age=3600; Path=/';` : ""}
      document.body.textContent = String(localStorage.getItem('owner')) + '|' + document.cookie;
      </script></body></html>`;
      if (url.searchParams.has("concurrent")) {
        barrier.push({ response, html });
        if (barrier.length === 2)
          for (const page of barrier.splice(0))
            page.response
              .writeHead(200, { "content-type": "text/html" })
              .end(page.html);
      } else response.writeHead(200, { "content-type": "text/html" }).end(html);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test server port");
    const base = `http://127.0.0.1:${address.port}/state`;
    try {
      const settings = {
        dataDirectory: directory,
        taskTimeoutSeconds: 600,
        executablePath: process.env.PATH!,
        playwrightBrowsersPath:
          process.env.PLAYWRIGHT_BROWSERS_PATH ||
          join(
            platform() === "darwin"
              ? join(homedir(), "Library", "Caches")
              : process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
            "ms-playwright",
          ),
      };
      const [first, second] = await Promise.all([
        prepareAgentProcess({
          ...settings,
          agentId: "first",
          token: "a".repeat(64),
          port: 0,
        }),
        prepareAgentProcess({
          ...settings,
          agentId: "second",
          token: "b".repeat(64),
          port: 0,
        }),
      ]);
      const script = join(directory, "browser probe's $(false).js");
      const node = join(directory, "node's runtime");
      await symlink(
        fileURLToPath(
          new URL("../apps/agent-host/dist/browser-demo.js", import.meta.url),
        ),
        script,
      );
      await symlink(process.execPath, node);
      async function browse(prepared: typeof first, query: string) {
        const url = `${base}${query}`;
        const { stdout } = await execute(
          "/bin/sh",
          ["-c", `${browserCommand(node, script)} '${url}'`],
          {
            cwd: prepared.cwd,
            env: prepared.env,
            timeout: 35000,
            maxBuffer: 100000,
          },
        );
        const result = JSON.parse(stdout);
        expect(result.title).toBe("Profile fixture");
        return result.text as string;
      }
      const initial = await Promise.all([
        browse(first, "?set=first&concurrent=1"),
        browse(second, "?concurrent=1"),
      ]);
      expect(initial).toEqual(["first|owner=first", "null|"]);
      expect(await browse(second, "?set=second")).toBe("second|owner=second");
      const restored = await Promise.all([
        browse(first, "?concurrent=1"),
        browse(second, "?concurrent=1"),
      ]);
      expect(restored).toEqual(["first|owner=first", "second|owner=second"]);
      expect(first.env.AGENT_BROWSER_PROFILE_DIR).not.toBe(
        second.env.AGENT_BROWSER_PROFILE_DIR,
      );
      expect((await readdir(first.directories.browser)).length).toBeGreaterThan(
        0,
      );
      expect(
        (await readdir(second.directories.browser)).length,
      ).toBeGreaterThan(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);
