import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { openMcpCatalog } from "./mcp-catalog.js";
import { openMcpCredentials } from "./mcp-credentials.js";
import { createMcpDiscovery } from "./mcp-discovery.js";
import { createMcpExecution } from "./mcp-execution.js";
import { createMcpLocalRuntime } from "./mcp-local.js";
import { createMcpToolSelection } from "./mcp-tool-selection.js";

const hostSource = fileURLToPath(
  new URL("../../../agent-host/src/mcp-stdio.ts", import.meta.url),
);

async function hostEntrypoint(directory: string) {
  const path = join(directory, "mcp-stdio.mjs");
  await writeFile(
    path,
    stripTypeScriptTypes(await readFile(hostSource, "utf8")),
  );
  return path;
}

const fixture = `
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  const result = method === "initialize"
    ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: {name:"fixture",version:"1"} }
    : method === "tools/list"
      ? { tools: [{ name: "check", inputSchema: { type: "object" } }] }
      : { content: [{ type:"text", text: JSON.stringify({args, key: process.env.MCP_KEY, hasServerSecret: Boolean(process.env.NIMBOT_TEST_SECRET)}) }] };
  process.stdout.write(JSON.stringify({ jsonrpc:"2.0", id, result }) + "\\n");
}
`;

it.each(["npx", "uvx"] as const)(
  "discovers and executes %s catalog tools through the local Host process",
  async (launcher) => {
    const dir = await mkdtemp(join(tmpdir(), "nimbot-mcp-local-"));
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "fixture.mjs"), fixture);
    await writeFile(
      join(bin, launcher),
      '#!/bin/sh\nexec node "$(dirname "$0")/fixture.mjs" "$@"\n',
      { mode: 0o700 },
    );
    const catalog = openMcpCatalog(":memory:", (id) => id === "agent");
    const credentials = await openMcpCredentials(catalog, join(dir, "secrets"));
    const runtime = createMcpLocalRuntime(
      dir,
      [bin, process.env.PATH].join(delimiter),
      await hostEntrypoint(dir),
    );
    const args = ["--from", "git+https://example.test/package", "with spaces"];
    const environment = { MCP_KEY: "fixture-private-value" };
    const local = { launcher, args };
    const settings = {
      local,
      endpoint: "",
      label: "Fixture",
      enabled: true,
      tools: [],
    };
    vi.stubEnv("NIMBOT_TEST_SECRET", "server-only-fixture");
    try {
      const definition = await credentials.withEnvironment(
        environment,
        (reference) => catalog.create(settings, true, false, reference),
      );
      expect(JSON.stringify(definition)).not.toContain(environment.MCP_KEY);
      expect(
        await credentials.readEnvironment(definition.id, definition.revision),
      ).toEqual(environment);
      const discovery = await createMcpDiscovery(fetch, undefined, runtime)(
        "",
        undefined,
        undefined,
        undefined,
        { target: { ...local, id: definition.id }, environment },
      );
      expect(discovery.status).toBe("connected");
      if (discovery.status !== "connected") throw new Error(discovery.status);
      const active = catalog.activate(definition, discovery.tools)!.definition;
      expect(active.tools[0]?.access).toBe("write");
      const operation =
        createMcpToolSelection(catalog).descriptors("agent")[0]!.operation;
      const execute = createMcpExecution({
        catalog,
        credentials,
        localRuntime: runtime,
      });
      const context = {
        signal: new AbortController().signal,
        allowed: () => true,
      };
      const outcome = await execute("agent", operation, {}, context);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.error);
      expect(outcome.result).toMatchObject({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              args,
              key: "[redacted]",
              hasServerSecret: false,
            }),
          },
        ],
      });
      expect(
        catalog.setAccess("agent", active.id, active.revision, false),
      ).toBe(true);
      expect(await execute("agent", operation, {}, context)).toEqual({
        ok: false,
        error: "denied",
      });
      const changed = await credentials.withEnvironment(null, (reference) =>
        catalog.update(
          active.id,
          active.revision,
          {
            ...settings,
            local: { ...local, args: ["new"] },
          },
          reference,
        ),
      );
      expect(changed).toMatchObject({
        tools: [],
        toolSetup: "pending",
        credentialStatus: "none",
      });
      expect(catalog.accessScope("agent", active.id)).toBeUndefined();
      expect(
        await credentials.readEnvironment(active.id, active.revision),
      ).toBeUndefined();
      expect((await credentials.cleanup()).cleanupPending).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      runtime.close();
      catalog.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("reports a missing launcher without starting a process", async () => {
  const runtime = createMcpLocalRuntime(tmpdir(), "/nonexistent", hostSource);
  const result = await createMcpDiscovery(fetch, undefined, runtime)(
    "",
    undefined,
    undefined,
    undefined,
    {
      target: {
        launcher: "uvx",
        args: ["fixture"],
        id: "00000000-0000-0000-0000-000000000000",
      },
      environment: {},
    },
  );
  expect(result).toEqual({ status: "launcher_missing" });
  runtime.close();
});

it("stops a local MCP process group on cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-mcp-cancel-"));
  const bin = join(dir, "bin");
  const ready = join(dir, "ready");
  await mkdir(bin);
  await writeFile(
    join(bin, "uvx"),
    '#!/bin/sh\nprintf "%s" "$$" > "$READY_FILE"\ntrap "" TERM\nwhile true; do sleep 1; done\n',
    { mode: 0o700 },
  );
  const runtime = createMcpLocalRuntime(
    dir,
    [bin, process.env.PATH].join(delimiter),
    await hostEntrypoint(dir),
  );
  const controller = new AbortController();
  const discovery = createMcpDiscovery(fetch, undefined, runtime)(
    "",
    undefined,
    controller.signal,
    undefined,
    {
      target: {
        id: "00000000-0000-0000-0000-000000000000",
        launcher: "uvx",
        args: ["example"],
      },
      environment: { READY_FILE: ready },
    },
  );
  try {
    const pid = await vi.waitFor(async () => {
      const value = Number(await readFile(ready, "utf8"));
      expect(value).toBeGreaterThan(0);
      return value;
    });
    controller.abort();
    await discovery;
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  } finally {
    controller.abort();
    runtime.close();
    await discovery;
    await rm(dir, { recursive: true, force: true });
  }
});

it("closes local transports and rejects new connections during maintenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-mcp-close-"));
  const runtime = createMcpLocalRuntime(dir, process.env.PATH ?? "", "unused");
  try {
    await runtime.close();
    expect(() =>
      runtime.connect(
        {
          id: "12345678-1234-1234-1234-123456789012",
          launcher: "npx",
          args: [],
        },
        {},
        { timeoutMs: 1000, allowed: () => true },
      ),
    ).toThrow();
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("waits for an active local tool process to exit before closing the runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-mcp-drain-"));
  const bin = join(dir, "bin");
  await mkdir(bin);
  const pidFile = join(dir, "tool.pid");
  await writeFile(
    join(bin, "fixture.mjs"),
    `import {writeFileSync} from "node:fs";\nwriteFileSync(process.env.PID_FILE, String(process.pid));\n${fixture}`,
  );
  await writeFile(
    join(bin, "npx"),
    '#!/bin/sh\nexec node "$(dirname "$0")/fixture.mjs"\n',
    { mode: 0o700 },
  );
  const runtime = createMcpLocalRuntime(
    dir,
    [bin, process.env.PATH].join(delimiter),
    await hostEntrypoint(dir),
  );
  try {
    const connection = runtime.connect(
      {
        id: "12345678-1234-1234-1234-123456789012",
        launcher: "npx",
        args: [],
      },
      { PID_FILE: pidFile },
      { timeoutMs: 1000, allowed: () => true },
    );
    await connection.initialize();
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    await runtime.close();
    expect(connection.signal.aborted).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
