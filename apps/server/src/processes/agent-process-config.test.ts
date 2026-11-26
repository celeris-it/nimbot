import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentProcessDirectories,
  prepareAgentProcess,
} from "./agent-process-config.js";

const execute = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function options() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "nimbot-process-"));
  temporary.push(dataDirectory);
  return {
    dataDirectory,
    agentId: "agent-one",
    port: 41001,
    token: "a".repeat(64),
    taskTimeoutSeconds: 600,
    executablePath: process.env.PATH!,
  };
}

describe("Agent Host subprocess configuration", () => {
  it("allocates distinct persistent state and working directories for each agent", async () => {
    const settings = await options();
    const first = await prepareAgentProcess(settings);
    const second = await prepareAgentProcess({
      ...settings,
      agentId: "agent-two",
      token: "b".repeat(64),
      port: 41002,
    });
    for (const directory of Object.values(first.directories)) {
      expect((await stat(directory)).isDirectory()).toBe(true);
      expect((await stat(directory)).mode & 0o077).toBe(0);
      expect(Object.values(second.directories)).not.toContain(directory);
    }
    expect(first.cwd).toBe(first.directories.workspace);
    expect(first.env.AGENT_STATE_DIR).toBe(first.directories.tasks);
    expect(first.env.AGENT_BROWSER_PROFILE_DIR).toBe(first.directories.browser);
    expect(first.env.AGENT_BROWSER_PROFILE_DIR).not.toBe(
      second.env.AGENT_BROWSER_PROFILE_DIR,
    );
    expect(first.env.XDG_DATA_HOME).toBe(first.directories.data);
    expect(first.env.AGENT_HOST_BIND_ADDRESS).toBe("127.0.0.1");
    expect(first.env.AGENT_HOST_PORT).toBe("41001");
    expect(second.env.AGENT_HOST_PORT).toBe("41002");
    expect(first.env.AGENT_HOST_TOKEN).not.toBe(second.env.AGENT_HOST_TOKEN);

    const saved = join(first.directories.workspace, "retained.txt");
    await writeFile(saved, "persistent workspace");
    expect((await prepareAgentProcess(settings)).directories).toEqual(
      first.directories,
    );
    expect(await readFile(saved, "utf8")).toBe("persistent workspace");
  });

  it("starts a child without inheriting Server secrets or engine overrides", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "server-bot-secret");
    vi.stubEnv("PANEL_PASSWORD_HASH", "server-password-hash");
    vi.stubEnv("OPENAI_API_KEY", "server-provider-secret");
    vi.stubEnv("NODE_OPTIONS", "--trace-warnings");
    vi.stubEnv("OPENCODE_AUTH_CONTENT", "server-auth");
    const settings = await options();
    const prepared = await prepareAgentProcess(settings);
    const { stdout } = await execute(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      { cwd: prepared.cwd, env: prepared.env },
    );
    const childEnv = JSON.parse(stdout);
    expect(childEnv).toEqual(prepared.env);
    expect(stdout).not.toMatch(/server-(bot|password|provider|auth)/);
    expect(childEnv.HOME).toBe(prepared.directories.home);
    expect(childEnv.TMPDIR).toBe(prepared.directories.temporary);
    expect(childEnv.OPENCODE_CONFIG_CONTENT).toBe(
      '{"permissions":[{"action":"execute","resource":"*","effect":"deny"}]}',
    );
    expect(childEnv).not.toHaveProperty("NODE_OPTIONS");
    expect(childEnv).not.toHaveProperty("PLAYWRIGHT_BROWSERS_PATH");
  });

  it("recreates missing temporary and cache directories while retaining persistent files", async () => {
    const settings = await options();
    const prepared = await prepareAgentProcess(settings);
    const saved = join(prepared.directories.workspace, "persistent.txt");
    await writeFile(saved, "persistent state");
    await rm(prepared.directories.temporary, { recursive: true });
    await rm(prepared.directories.cache, { recursive: true });
    await prepareAgentProcess(settings);
    for (const path of [
      prepared.directories.temporary,
      prepared.directories.cache,
    ]) {
      const info = await stat(path);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
    }
    expect(await readFile(saved, "utf8")).toBe("persistent state");
  });

  it("accepts an explicit shared browser executable installation", async () => {
    const prepared = await prepareAgentProcess({
      ...(await options()),
      playwrightBrowsersPath: "/opt/playwright",
    });
    expect(prepared.env.PLAYWRIGHT_BROWSERS_PATH).toBe("/opt/playwright");
  });

  it.each([
    "",
    "..",
    "../../other",
    "/tmp/other",
    "a/b",
    "a\\b",
    "a".repeat(49),
  ])("rejects invalid agent ID %j before allocating directories", (agentId) => {
    expect(() => agentProcessDirectories("/tmp/data", agentId)).toThrow(
      "Invalid agent ID",
    );
  });

  it("rejects invalid launch settings before touching the filesystem", async () => {
    const settings = await options();
    for (const invalid of [
      { token: "secret" },
      { port: -1 },
      { port: 65536 },
      { port: 1.5 },
      { taskTimeoutSeconds: 9 },
      { taskTimeoutSeconds: 3601 },
      { executablePath: "" },
    ]) {
      await expect(
        prepareAgentProcess({ ...settings, ...invalid }),
      ).rejects.toThrow();
    }
    await expect(
      stat(join(settings.dataDirectory, "agents")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
