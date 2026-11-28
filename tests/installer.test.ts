import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  cp,
  rm,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { once } from "node:events";

const execute = promisify(execFile);
// Each case invokes several real Bash/Python subprocesses; allow for loaded CI hosts.
vi.setConfig({ testTimeout: 20000 });
const root = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

// A real controlling terminal also verifies the curl | bash entry path.
// Docker and downloads are simulated; no external service is used.
const terminal = String.raw`
import os, sys, json, socket, pty, select, time
config = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(config['command'][0], config['command'], os.environ)
output = b''
pending = list(config['answers'])
cursor = 0
deadline = time.time() + 20
while time.time() < deadline:
    if select.select([fd], [], [], 0.1)[0]:
        try: data = os.read(fd, 65536)
        except OSError: break
        if not data: break
        output += data
        while pending and pending[0][0].encode() in output[cursor:]:
            prompt, answer = pending.pop(0)
            cursor = output.index(prompt.encode(), cursor) + len(prompt.encode())
            os.write(fd, (answer + '\n').encode())
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        print(json.dumps({'code': os.waitstatus_to_exitcode(status), 'output': output.decode(errors='replace')}))
        sys.exit(0)
else:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
    raise RuntimeError('Terminal test timed out: ' + output.decode(errors='replace'))
_, status = os.waitpid(pid, 0)
print(json.dumps({'code': os.waitstatus_to_exitcode(status), 'output': output.decode(errors='replace')}))
`;

const docker = String.raw`#!/usr/bin/env python3
import os, sys, json
from pathlib import Path
args = sys.argv[1:]
statefile = Path(os.environ['FAKE_STATE'])
state = json.loads(statefile.read_text())
with open(os.environ['FAKE_LOG'], 'a') as f: f.write(json.dumps(args) + '\n')
def save(): statefile.write_text(json.dumps(state))
def labels():
    return dict(args[i+1].split('=',1) for i,a in enumerate(args) if a == '--label')
def fail(): sys.exit(1)
if args[0] == 'context': print(os.environ.get('FAKE_ENDPOINT', 'unix://' + os.environ['FAKE_SOCKET']))
elif args[0] == 'info': pass
elif args[0] == 'build':
    if os.environ.get('FAKE_FAIL') == 'build': fail()
elif args[0] == 'exec':
    env = Path(state['container'][args[1]]['env']).read_text()
    origin = next(line.split('=',1)[1] for line in env.splitlines() if line.startswith('PANEL_URL='))
    print(origin + ('/login' if 'PANEL_PASSWORD_HASH=' in env else '/setup#token=' + 'a'*64))
elif args[0] == 'run':
    if '-i' in args:
        password = sys.stdin.read()
        if len(password) < 8 or len(password) > 256: fail()
        print('scrypt:' + 'a'*32 + ':' + 'b'*128)
    elif '-d' in args:
        if os.environ.get('FAKE_FAIL') == 'run': fail()
        name = args[args.index('--name')+1]
        state['container'][name] = {'labels': labels(), 'status':'running', 'health':'healthy', 'env':args[args.index('--env-file')+1]}
        save(); print(name)
    else: sys.exit(2)
elif args[0] in ['container', 'volume']:
    kind, action = args[:2]
    resources = state[kind]
    if action == 'ls':
        if os.environ.get('FAKE_FAIL') == 'list': fail()
        print('\n'.join(resources))
    elif action == 'create':
        resources.setdefault(args[-1], {'labels': labels()}); save(); print(args[-1])
    elif action == 'inspect':
        if os.environ.get('FAKE_FAIL') == 'inspect': fail()
        name = args[-1]
        if name not in resources: fail()
        item = resources[name]
        fmt = args[args.index('--format')+1]
        if '.State.Status' in fmt: print(item['status'] + ' ' + ('unhealthy' if os.environ.get('FAKE_FAIL') == 'health' else item['health']))
        elif 'io.nimbot.layout' in fmt: print(item['labels'].get('io.nimbot.layout',''))
        else: print('foreign' if os.environ.get('FAKE_FOREIGN') == name else item['labels'].get('io.nimbot.installation',''))
    elif action == 'start': resources[args[-1]]['status']='running'; save()
    elif action == 'stop': resources[args[-1]]['status']='exited'; save()
    elif action == 'rm':
        if os.environ.get('FAKE_REMOVE_FAIL') == args[-1]: fail()
        del resources[args[-1]]; save()
    else: sys.exit(2)
else: sys.exit(2)
`;
const panelAnswers: string[][] = [];
type Resource = {
  labels: Record<string, string>;
  status?: string;
  health?: string;
};
type State = {
  container: Record<string, Resource>;
  volume: Record<string, Resource>;
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nimbot-installer-"));
  temporary.push(directory);
  const bin = join(directory, "bin");
  const source = join(directory, "source");
  const destination = join(directory, "installation with spaces");
  await mkdir(bin);
  await mkdir(source);
  await mkdir(join(source, "infrastructure/docker"), { recursive: true });
  for (const file of [
    "install.sh",
    "uninstall.sh",
    "upgrade.sh",
    "release.json",
    "infrastructure/docker/nimbot.Dockerfile",
  ])
    await cp(join(root, file), join(source, file));
  const archive = join(directory, "source.tar.gz");
  await execute("tar", ["-czf", archive, "-C", directory, "source"]);
  await writeFile(join(bin, "docker"), docker, { mode: 0o755 });
  await writeFile(
    join(bin, "curl"),
    '#!/usr/bin/env bash\nwhile [ "$1" != -o ]; do shift; done\ncp "$FAKE_ARCHIVE" "$2"\n',
    { mode: 0o755 },
  );
  const statePath = join(directory, "state.json");
  const log = join(directory, "docker.log");
  await writeFile(statePath, JSON.stringify({ container: {}, volume: {} }));
  await writeFile(log, "");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_STATE: statePath,
    FAKE_LOG: log,
    FAKE_ARCHIVE: archive,
    FAKE_SOCKET: join(directory, "docker.sock"),
    PANEL_PASSWORD: "",
    PANEL_PASSWORD_HASH: "",
    DOCKER_HOST: "",
    DOCKER_CONTEXT: "",
  };
  async function run(
    script: "install" | "uninstall" | "upgrade",
    answers: string[][] = [],
    extra: string[] = [],
    overrides: Record<string, string> = {},
    pipe = false,
  ) {
    const command = pipe
      ? [
          "bash",
          "-c",
          'cat "$1" | bash -s -- --directory "$2"',
          "test",
          join(root, "install.sh"),
          destination,
        ]
      : [
          "bash",
          join(root, `${script}.sh`),
          "--directory",
          destination,
          ...extra,
        ];
    const result = await execute(
      "python3",
      ["-c", terminal, JSON.stringify({ command, answers })],
      { env: { ...env, ...overrides }, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(result.stdout) as { code: number; output: string };
  }
  const readState = async () =>
    JSON.parse(await readFile(statePath, "utf8")) as State;
  const writeState = async (state: State) =>
    writeFile(statePath, JSON.stringify(state));
  const commands = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  async function resources() {
    const marker = (
      await readFile(join(destination, ".nimbot-installation"), "utf8")
    ).split("\n");
    return {
      id: marker[1]!,
      container: `nimbot-${marker[1]}`,
      volume: `nimbot-${marker[1]}-data`,
      marker,
    };
  }
  return {
    directory,
    destination,
    run,
    readState,
    writeState,
    commands,
    resources,
    install: () => run("install", panelAnswers),
    installWithoutTerminal: () =>
      execute("bash", [join(root, "install.sh"), "--directory", destination], {
        env,
        maxBuffer: 1024 * 1024,
      }),
  };
}

it("installs one application through piped stdin without Compose or a socket mount", async () => {
  const f = await fixture();
  const result = await f.run("install", panelAnswers, [], {}, true);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain("Nimbot is ready at http://localhost:3000");
  expect(result.output).not.toContain("long-enough-password");
  const env = await readFile(join(f.destination, ".env"), "utf8");
  expect(env).not.toContain("PANEL_PASSWORD_HASH=");
  expect(result.output).toContain("/setup#token=");
  expect(env).not.toMatch(
    /DOCKER_SOCKET|AGENT_HOST_IMAGE|long-enough-password|'scrypt/,
  );
  expect((await stat(join(f.destination, ".env"))).mode & 0o777).toBe(0o600);
  const commands = await f.commands();
  expect(commands.filter((a) => a[0] === "build")).toHaveLength(1);
  expect(
    commands.some((a) => a.includes("compose") || a[0] === "network"),
  ).toBe(false);
  const run = commands.find((a) => a[0] === "run" && a.includes("-d"))!;
  expect(run).toContain("127.0.0.1:3000:3000");
  expect(run).toContain("--init");
  expect(run).not.toContain("--user");
  expect(run.filter((a) => a === "--mount")).toHaveLength(1);
  expect(run.join(" ")).not.toContain("docker.sock");
  const { container, volume, marker } = await f.resources();
  expect(marker[0]).toBe("subprocess-v1");
  expect(Object.keys((await f.readState()).container)).toEqual([container]);
  expect(Object.keys((await f.readState()).volume)).toEqual([volume]);
});

it("reuses configuration and the retained volume after uninstall without downloading or resetting the password", async () => {
  const f = await fixture();
  expect((await f.install()).code).toBe(0);
  const env = await readFile(join(f.destination, ".env"), "utf8");
  const { container, volume } = await f.resources();
  const before = (await f.commands()).length;
  expect((await f.run("uninstall", [["Continue? [y/N]: ", "y"]])).code).toBe(0);
  expect((await f.readState()).container[container]).toBeUndefined();
  expect((await f.readState()).volume[volume]).toBeDefined();
  const result = await f.run("install");
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain("Reusing existing installation");
  expect(await readFile(join(f.destination, ".env"), "utf8")).toBe(env);
  const later = (await f.commands()).slice(before);
  expect(
    later.some((a) => a.includes("password.js") || a.includes("--stdin")),
  ).toBe(false);
  expect(later.some((a) => a[0] === "volume" && a[1] === "create")).toBe(false);
});

it("accepts explicit ports and HTTPS origins without prompting", async () => {
  const f = await fixture();
  for (const options of [
    ["--port", "65536"],
    ["--port", "0"],
    ["--port", ""],
    ["--url", ""],
    ["--url", "https://example.test/path"],
  ]) {
    expect((await f.run("install", [], options)).code).toBe(1);
  }
  expect(await f.commands()).toEqual([]);
  const result = await f.run(
    "install",
    [],
    ["--port", "3101", "--url", "https://nimbot.example.test"],
  );
  expect(result.code, result.output).toBe(0);
  const env = await readFile(join(f.destination, ".env"), "utf8");
  expect(env).toContain("PANEL_PUBLISH_PORT=3101");
  expect(env).toContain("PANEL_URL=https://nimbot.example.test\n");
  expect(
    (await f.commands()).find((a) => a[0] === "run" && a.includes("-d")),
  ).toContain("127.0.0.1:3101:3000");
  expect((await f.run("install", [], ["--port", "3102"])).output).toContain(
    "edit .env",
  );
  expect(
    (await f.run("install", [], ["--url", "https://other.test"])).output,
  ).toContain("edit .env");
  expect((await f.run("install")).code).toBe(0);
  expect(await readFile(join(f.destination, ".env"), "utf8")).toBe(env);
});

it("reports an occupied port before building or creating Docker resources", async () => {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  try {
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port");
    const f = await fixture();
    const result = await f.run("install", [], ["--port", String(address.port)]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("already in use. Retry with --port");
    expect(
      (await f.commands()).some(
        (args) => ["build", "run"].includes(args[0]!) || args[1] === "create",
      ),
    ).toBe(false);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

it("installs with no controlling terminal", async () => {
  const f = await fixture();
  const result = await f.installWithoutTerminal();
  expect(result.stdout).toContain("/setup#token=");
});

it.each(["PANEL_PASSWORD", "PANEL_PASSWORD_HASH"])(
  "uses %s from the environment and saves only its hash",
  async (key) => {
    const f = await fixture();
    const value =
      key === "PANEL_PASSWORD"
        ? "long-enough-password"
        : "scrypt:" + "c".repeat(32) + ":" + "d".repeat(128);
    const result = await f.run("install", [], [], { [key]: value });
    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain(value);
    expect(result.output).toContain("/login");
    const env = await readFile(join(f.destination, ".env"), "utf8");
    expect(env).toContain("PANEL_PASSWORD_HASH=scrypt:");
    expect(env).not.toContain("PANEL_PASSWORD=");
    expect(env).not.toContain("long-enough-password");
    expect(JSON.stringify(await f.commands())).not.toContain(value);
  },
);

it("rejects invalid environment passwords before Docker operations and gives the hash priority", async () => {
  const f = await fixture();
  expect(
    (await f.run("install", [], [], { PANEL_PASSWORD: "short" })).code,
  ).toBe(1);
  expect(
    (
      await f.run("install", [], [], {
        PANEL_PASSWORD_HASH: "invalid",
        PANEL_PASSWORD: "valid-password",
      })
    ).code,
  ).toBe(1);
  expect(await f.commands()).toEqual([]);
  const hash = "scrypt:" + "c".repeat(32) + ":" + "d".repeat(128);
  expect(
    (
      await f.run("install", [], [], {
        PANEL_PASSWORD_HASH: hash,
        PANEL_PASSWORD: "short",
      })
    ).code,
  ).toBe(0);
  expect(await readFile(join(f.destination, ".env"), "utf8")).toContain(hash);
});

it("rejects remote Docker and pre-existing legacy state without mutating resources", async () => {
  const f = await fixture();
  expect(
    (await f.run("install", [], [], { FAKE_ENDPOINT: "tcp://remote:2375" }))
      .code,
  ).toBe(1);
  await mkdir(f.destination);
  const marker = "a".repeat(32) + "\n/old/docker.sock\n";
  await writeFile(join(f.destination, ".nimbot-installation"), marker);
  const result = await f.run("install");
  expect(result.output).toContain("fresh subprocess installation");
  expect(
    await readFile(join(f.destination, ".nimbot-installation"), "utf8"),
  ).toBe(marker);
  expect(
    (await f.commands()).every((a) => ["context", "info"].includes(a[0]!)),
  ).toBe(true);
  expect((await f.run("uninstall")).code).toBe(1);
});

it.each(["build", "run", "health"])(
  "keeps resources and configuration after a %s failure and permits retry",
  async (failure) => {
    const f = await fixture();
    const failed = await f.run("install", panelAnswers, [], {
      FAKE_FAIL: failure,
    });
    expect(failed.code).toBe(1);
    expect(
      await readFile(join(f.destination, ".nimbot-installation"), "utf8"),
    ).toContain("subprocess-v1");
    const retry = await f.run(
      "install",
      failure === "build" ? panelAnswers : [],
    );
    expect(retry.code, retry.output).toBe(0);
  },
);

it("rejects foreign labels and uncertain resource listings before lifecycle mutations", async () => {
  const f = await fixture();
  expect((await f.install()).code).toBe(0);
  const { container } = await f.resources();
  const before = (await f.commands()).length;
  for (const overrides of [
    { FAKE_FOREIGN: container },
    { FAKE_FAIL: "list" },
    { FAKE_FAIL: "inspect" },
  ]) {
    expect((await f.run("install", [], [], overrides)).code).toBe(1);
    expect((await f.run("uninstall", [], [], overrides)).code).toBe(1);
  }
  expect(
    (await f.commands())
      .slice(before)
      .every(
        (a) =>
          ["context", "info"].includes(a[0]!) ||
          ["ls", "inspect"].includes(a[1]!),
      ),
  ).toBe(true);
});

it("requires both purge confirmations before deleting anything and preserves foreign resources", async () => {
  const f = await fixture();
  expect((await f.install()).code).toBe(0);
  const { container, volume } = await f.resources();
  const state = await f.readState();
  state.container.foreign = { labels: { "io.nimbot.installation": "other" } };
  state.volume.foreign = { labels: {} };
  await f.writeState(state);
  expect(
    (await f.run("uninstall", [["Continue? [y/N]: ", "n"]], ["--purge-data"]))
      .code,
  ).toBe(0);
  const rejected = await f.run(
    "uninstall",
    [
      ["Continue? [y/N]: ", "y"],
      ["Type DELETE NIMBOT DATA", "NO"],
    ],
    ["--purge-data"],
  );
  expect(rejected.code).toBe(1);
  expect((await f.readState()).container[container]).toBeDefined();
  const purged = await f.run(
    "uninstall",
    [
      ["Continue? [y/N]: ", "y"],
      ["Type DELETE NIMBOT DATA", "DELETE NIMBOT DATA"],
    ],
    ["--purge-data"],
  );
  expect(purged.code, purged.output).toBe(0);
  const after = await f.readState();
  expect(after.container[container]).toBeUndefined();
  expect(after.volume[volume]).toBeUndefined();
  expect(after.container.foreign).toBeDefined();
  expect(after.volume.foreign).toBeDefined();
  await expect(readFile(join(f.destination, ".env"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("retains data on partial uninstall and permits a later explicit purge", async () => {
  const f = await fixture();
  await f.install();
  const { container, volume } = await f.resources();
  expect(
    (
      await f.run("uninstall", [["Continue? [y/N]: ", "y"]], [], {
        FAKE_REMOVE_FAIL: container,
      })
    ).code,
  ).toBe(1);
  expect((await f.readState()).volume[volume]).toBeDefined();
  expect((await f.run("uninstall", [["Continue? [y/N]: ", "y"]])).code).toBe(0);
  expect((await f.readState()).volume[volume]).toBeDefined();
  expect(
    (
      await f.run(
        "uninstall",
        [
          ["Continue? [y/N]: ", "y"],
          ["Type DELETE NIMBOT DATA", "DELETE NIMBOT DATA"],
        ],
        ["--purge-data"],
      )
    ).code,
  ).toBe(0);
});

it("pins an initial release, serializes maintenance, and never invokes the old upgrade helper", async () => {
  const f = await fixture();
  const first = await f.run("install", panelAnswers, ["--version", "v1.0.0"]);
  expect(first.code, first.output).toBe(0);
  expect((await f.resources()).marker[3]).toBe("v1.0.0");
  expect(
    (await f.run("install", [], ["--version", "v2.0.0"])).output,
  ).toContain("manual update procedure");
  await symlink("123", join(f.destination, ".nimbot-maintenance"));
  expect((await f.run("install")).output).toContain(
    "maintenance is already in progress",
  );
  const before = (await f.commands()).length;
  const upgrade = await f.run("upgrade", [], ["--version", "v2.0.0"]);
  expect(upgrade.code).toBe(1);
  expect(upgrade.output).toContain("does not migrate or import");
  expect((await f.commands()).length).toBe(before);
  expect(
    JSON.parse(await readFile(join(root, "release.json"), "utf8")).upgradeFrom,
  ).toBeNull();
});

it("does not replace a missing retained data volume with an empty one", async () => {
  const f = await fixture();
  await f.install();
  const { volume } = await f.resources();
  await f.run("uninstall", [["Continue? [y/N]: ", "y"]]);
  const state = await f.readState();
  delete state.volume[volume];
  await f.writeState(state);
  const before = (await f.commands()).length;
  const result = await f.run("install");
  expect(result.code).toBe(1);
  expect(result.output).toContain("data volume is missing");
  expect(
    (await f.commands())
      .slice(before)
      .some((a) => a[0] === "volume" && a[1] === "create"),
  ).toBe(false);
});
