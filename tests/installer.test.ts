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

vi.setConfig({ testTimeout: 30000 });
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// Give the scripts a real controlling terminal, including when their stdin is a pipe.
// Docker and HTTPS downloads are simulated; no real engine or network is used.
const terminal = String.raw`
import os, sys, json, socket, pty, select, time
config = json.loads(sys.argv[1])
sock = socket.socket(socket.AF_UNIX)
sock.bind(os.environ['FAKE_SOCKET'])
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
dir = Path(os.environ['INSTALL_DIR'])
statefile = Path(os.environ['FAKE_STATE'])
state = json.loads(statefile.read_text())
with open(os.environ['FAKE_LOG'], 'a') as f: f.write(json.dumps(args) + '\n')
marker = dir / '.nimbot-installation'
owner = marker.read_text().splitlines()[0] if marker.exists() else 'unknown'
if os.environ.get('FAKE_FAIL') == args[0]: sys.exit(1)
def save(): statefile.write_text(json.dumps(state))
if args[0] == 'context': print(os.environ.get('FAKE_ENDPOINT', 'unix://' + os.environ['FAKE_SOCKET']))
elif args[0] == 'info': pass
elif args[:2] == ['compose', 'version']: print('Docker Compose version v2.39.0')
elif args[0] == 'version': print(os.environ.get('FAKE_API', '1.47'))
elif args[0] == 'build': pass
elif args[0] == 'image' and args[1] == 'inspect': print('sha256:' + 'a'*64)
elif args[0] == 'run' and 'stat' in args: print('0')
elif args[0] == 'run' and '/app/scripts/upgrade.mjs' in args:
    print('Upgrade helper invoked')
elif args[0] == 'run':
    password = sys.stdin.read()
    if len(password) < 12 or len(password) > 256: sys.exit(1)
    print('scrypt:' + 'a'*32 + ':' + 'b'*128)
elif args[0] == 'compose':
    if 'up' in args:
        if os.environ.get('FAKE_FAIL') == 'health': sys.exit(1)
        state['container']['server'] = {'owner': owner, 'project': 'nimbot-' + owner}
        state['network']['default'] = {'owner': owner}
        state['volume']['server-state'] = {'owner': owner}
        save()
elif args[0] in ['container', 'network', 'volume'] or args[0] in ['ps', 'inspect']:
    kind = 'container' if args[0] in ['ps', 'inspect'] else args[0]
    action = 'ls' if args[0] == 'ps' else ('inspect' if args[0] == 'inspect' else args[1])
    resources = state[kind]
    if action == 'ls':
        if '--filter' not in args: sys.exit(2)
        filter = args[args.index('--filter')+1]
        for key, value in resources.items():
            if filter.startswith('name='):
                if key == 'server': print(key)
            elif filter == 'label=io.nimbot.installation' or filter == 'label=io.nimbot.agent-id': print(key)
            elif filter.startswith('label=io.nimbot.installation=') and value['owner'] == filter.split('=', 2)[2]: print(key)
    elif action == 'inspect':
        ref = args[-1]
        if ref not in resources: sys.exit(1)
        value = resources[ref]
        if 'com.docker.compose.project' in args[args.index('--format')+1]: print(value.get('project', ''))
        else: print('foreign' if os.environ.get('FAKE_FOREIGN') == ref else value['owner'])
    elif action == 'stop': pass
    elif action == 'rm':
        ref = args[-1]
        if os.environ.get('FAKE_REMOVE_FAIL') == ref: sys.exit(1)
        del resources[ref]; save()
    else: sys.exit(2)
else: sys.exit(2)
`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-installer-"));
  temporary.push(dir);
  const bin = join(dir, "bin");
  const source = join(dir, "source");
  const destination = join(dir, "installation with spaces");
  await mkdir(bin);
  await mkdir(source);
  for (const name of [
    "compose.yaml",
    "install.sh",
    "uninstall.sh",
    "upgrade.sh",
    "release.json",
  ])
    await cp(join(root, name), join(source, name));
  const archive = join(dir, "source.tar.gz");
  await exec("tar", ["-czf", archive, "-C", dir, "source"]);
  await writeFile(join(bin, "docker"), docker, { mode: 0o755 });
  await writeFile(
    join(bin, "curl"),
    '#!/usr/bin/env bash\nwhile [ "$1" != -o ]; do shift; done\ncp "$FAKE_ARCHIVE" "$2"\n',
    { mode: 0o755 },
  );
  const statePath = join(dir, "state.json");
  const log = join(dir, "docker.log");
  await writeFile(
    statePath,
    JSON.stringify({ container: {}, network: {}, volume: {} }),
  );
  await writeFile(log, "");
  let invocation = 0;
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    INSTALL_DIR: destination,
    FAKE_STATE: statePath,
    FAKE_LOG: log,
    FAKE_ARCHIVE: archive,
    DOCKER_HOST: "",
    DOCKER_CONTEXT: "",
  };
  async function run(
    script: "install" | "uninstall" | "upgrade",
    answers: string[][],
    extra: string[] = [],
    overrides: Record<string, string> = {},
    pipe = false,
  ) {
    const command = [
      "bash",
      join(root, `${script}.sh`),
      "--directory",
      destination,
      ...extra,
    ];
    // stdin is a pipe in the remote curl | bash invocation; /dev/tty remains usable.
    const actual = pipe
      ? [
          "bash",
          "-c",
          'cat "$1" | bash -s -- --directory "$2"',
          "test",
          join(root, "install.sh"),
          destination,
        ]
      : command;
    const result = await exec(
      "python3",
      ["-c", terminal, JSON.stringify({ command: actual, answers })],
      {
        env: {
          ...env,
          FAKE_SOCKET: join(dir, `docker-${invocation++}.sock`),
          ...overrides,
        },
        maxBuffer: 1024 * 1024,
      },
    );
    return JSON.parse(result.stdout) as { code: number; output: string };
  }
  // Reuse one socket path: the terminal runner unlinks it before each binding.
  const stableSocket = join(dir, "docker.sock");
  const runStable: typeof run = async (...args) => {
    await rm(stableSocket, { force: true });
    const [script, answers, extra = [], overrides = {}, pipe = false] = args;
    return run(
      script,
      answers,
      extra,
      { FAKE_SOCKET: stableSocket, ...overrides },
      pipe,
    );
  };
  const install = () =>
    runStable("install", [
      ["Panel URL [", ""],
      ["characters, hidden): ", "long-enough-password"],
      ["Repeat password: ", "long-enough-password"],
    ]);
  const readState = async () =>
    JSON.parse(await readFile(statePath, "utf8")) as Record<
      string,
      Record<string, { owner: string; project?: string }>
    >;
  async function addAgents() {
    const state = await readState();
    const owner = (
      await readFile(join(destination, ".nimbot-installation"), "utf8")
    ).split("\n")[0]!;
    state.container!.agent = { owner };
    state.network!.agent = { owner };
    state.volume!.agent = { owner };
    state.volume!.foreign = { owner: "foreign" };
    state.network!.foreign = { owner: "foreign" };
    await writeFile(statePath, JSON.stringify(state));
  }
  return {
    run: runStable,
    install,
    destination,
    log,
    readState,
    addAgents,
    statePath,
  };
}

it("installs through piped stdin, writes private configuration, and waits for health", async () => {
  const f = await fixture();
  const result = await f.run(
    "install",
    [
      ["Panel URL [", ""],
      ["characters, hidden): ", "long-enough-password"],
      ["Repeat password: ", "long-enough-password"],
    ],
    [],
    {},
    true,
  );
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain("Nimbot is ready at http://localhost:3000");
  expect(result.output).not.toContain("long-enough-password");
  const config = await readFile(join(f.destination, ".env"), "utf8");
  expect(config).toContain("DOCKER_SOCKET_GID=");
  expect(config).toContain("NIMBOT_INSTALLATION_ID=");
  expect(config).not.toContain("long-enough-password");
  expect((await stat(join(f.destination, ".env"))).mode & 0o777).toBe(0o600);
  expect(await readFile(f.log, "utf8")).toContain('"--wait-timeout", "120"');
});

it("reuses an installation without replacing its password or downloading updates", async () => {
  const f = await fixture();
  expect((await f.install()).code).toBe(0);
  const config = await readFile(join(f.destination, ".env"), "utf8");
  const result = await f.run("install", []);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain("Reusing existing installation");
  expect(await readFile(join(f.destination, ".env"), "utf8")).toBe(config);
});

it("rejects remote contexts and unrelated destination directories before builds", async () => {
  const f = await fixture();
  const remote = await f.run("install", [], [], {
    FAKE_ENDPOINT: "ssh://host",
  });
  expect(remote.code).not.toBe(0);
  expect(remote.output).toContain("remote Docker is unsupported");
  await mkdir(f.destination);
  await writeFile(join(f.destination, "mine"), "keep");
  const occupied = await f.run("install", []);
  expect(occupied.code).not.toBe(0);
  expect(occupied.output).toContain("Destination is not empty");
  expect(await readFile(join(f.destination, "mine"), "utf8")).toBe("keep");
});

it("allows password correction and an existing HTTPS origin", async () => {
  const f = await fixture();
  const result = await f.run("install", [
    ["Panel URL [", "https://nimbot.example.com"],
    ["characters, hidden): ", "short"],
    ["Repeat password: ", "short"],
    ["characters, hidden): ", "long-enough-password"],
    ["Repeat password: ", "different"],
    ["characters, hidden): ", "long-enough-password"],
    ["Repeat password: ", "long-enough-password"],
  ]);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain("Password was rejected");
  expect(result.output).toContain("Passwords do not match");
  expect(result.output).toContain(
    "Nimbot is ready at https://nimbot.example.com",
  );
});

it.each(["build", "health"])(
  "reports %s failures and keeps the installation for retry",
  async (failure) => {
    const f = await fixture();
    const result = await f.run(
      "install",
      failure === "build"
        ? []
        : [
            ["Panel URL [", ""],
            ["characters, hidden): ", "long-enough-password"],
            ["Repeat password: ", "long-enough-password"],
          ],
      [],
      { FAKE_FAIL: failure },
    );
    expect(result.code).not.toBe(0);
    expect(
      await readFile(join(f.destination, ".nimbot-installation"), "utf8"),
    ).toMatch(/^[a-f0-9]{32}\n/);
    expect(result.output).toContain(
      failure === "health" ? "did not become healthy" : "Installation failed",
    );
  },
);

it("uninstalls server before agents, keeps data, and leaves foreign resources alone", async () => {
  const f = await fixture();
  expect((await f.install()).code).toBe(0);
  await f.addAgents();
  const result = await f.run("uninstall", [["Continue? [y/N]: ", "y"]]);
  expect(result.code, result.output).toBe(0);
  const state = await f.readState();
  expect(state.container).toEqual({});
  expect(state.network).toEqual({ foreign: { owner: "foreign" } });
  expect(Object.keys(state.volume!)).toEqual([
    "server-state",
    "agent",
    "foreign",
  ]);
  expect(await readFile(join(f.destination, ".env"), "utf8")).toContain(
    "PANEL_PASSWORD_HASH",
  );
  const calls = (await readFile(f.log, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  const stops = calls.filter(
    (args) => args[0] === "container" && args[1] === "stop",
  );
  expect(stops[0]?.at(-1)).toBe("server");
});

it("requires purge confirmation before any mutation and can purge retained data later", async () => {
  const f = await fixture();
  expect((await f.install()).code).toBe(0);
  await f.addAgents();
  const denied = await f.run(
    "uninstall",
    [
      ["Continue? [y/N]: ", "y"],
      ["permanent data deletion: ", "no"],
    ],
    ["--purge-data"],
  );
  expect(denied.code).not.toBe(0);
  expect((await f.readState()).container!.server).toBeDefined();
  expect((await f.run("uninstall", [["Continue? [y/N]: ", "y"]])).code).toBe(0);
  const purged = await f.run(
    "uninstall",
    [
      ["Continue? [y/N]: ", "y"],
      ["permanent data deletion: ", "DELETE NIMBOT DATA"],
    ],
    ["--purge-data"],
  );
  expect(purged.code, purged.output).toBe(0);
  expect((await f.readState()).volume).toEqual({
    foreign: { owner: "foreign" },
  });
  await expect(readFile(join(f.destination, ".env"))).rejects.toThrow();
});

it("rejects foreign resources after inspection and permits retry after partial cleanup", async () => {
  const f = await fixture();
  expect((await f.install()).code).toBe(0);
  await f.addAgents();
  const foreign = await f.run("uninstall", [], [], { FAKE_FOREIGN: "server" });
  expect(foreign.code).not.toBe(0);
  expect(foreign.output).toContain("Refusing foreign container");
  const partial = await f.run("uninstall", [["Continue? [y/N]: ", "y"]], [], {
    FAKE_REMOVE_FAIL: "agent",
  });
  expect(partial.code).not.toBe(0);
  expect((await f.readState()).container!.agent).toBeDefined();
  expect((await f.run("uninstall", [["Continue? [y/N]: ", "y"]])).code).toBe(0);
});

it("rejects unsupported Docker and a conflicting server without building", async () => {
  const f = await fixture();
  const unsupported = await f.run("install", [], [], { FAKE_API: "1.46" });
  expect(unsupported.code).not.toBe(0);
  expect(unsupported.output).toContain("1.47 or newer");
  expect(await readFile(f.log, "utf8")).not.toContain('"build"');
  expect((await f.install()).code).toBe(0);
  const conflict = await f.run("install", [], [], { FAKE_FOREIGN: "server" });
  expect(conflict.code).not.toBe(0);
  expect(conflict.output).toContain("belongs to another installation");
});

it("cancels uninstall without changes and cleans incomplete setup resources", async () => {
  const f = await fixture();
  expect((await f.install()).code).toBe(0);
  const before = await f.readState();
  const owner = before.container!.server!.owner;
  before.network!.pending = { owner };
  before.volume!.pending = { owner };
  await writeFile(f.statePath, JSON.stringify(before));
  const cancelled = await f.run("uninstall", [["Continue? [y/N]: ", ""]]);
  expect(cancelled.code).toBe(0);
  expect(await f.readState()).toEqual(before);
  const result = await f.run("uninstall", [["Continue? [y/N]: ", "y"]]);
  expect(result.code, result.output).toBe(0);
  expect((await f.readState()).network).toEqual({});
  expect((await f.readState()).volume!.pending).toEqual({ owner });
});

it("installs a pinned release and rejects switching tags through the installer", async () => {
  const f = await fixture();
  const result = await f.run(
    "install",
    [
      ["Panel URL [", ""],
      ["characters, hidden): ", "long-enough-password"],
      ["Repeat password: ", "long-enough-password"],
    ],
    ["--version", "v1.0.0"],
  );
  expect(result.code).toBe(0);
  expect(await readFile(join(f.destination, ".nimbot-release"), "utf8")).toBe(
    "v1.0.0\n",
  );
  const retry = await f.run("install", [], ["--version", "v2.0.0"]);
  expect(retry.code).not.toBe(0);
  expect(retry.output).toContain("Use upgrade.sh");
});

it("stages the release for a custom directory and leaves the service alone on build failure", async () => {
  const f = await fixture();
  expect((await f.install()).code).toBe(0);
  await rm(join(f.destination, ".nimbot-release"));
  const before = await f.readState();
  const failed = await f.run("upgrade", [], ["--version", "v1.0.0"], {
    FAKE_FAIL: "build",
  });
  expect(failed.code).not.toBe(0);
  expect(await f.readState()).toEqual(before);
  const completed = await f.run("upgrade", [], ["--version", "v1.0.0"]);
  expect(completed.code).toBe(0);
  expect(completed.output).toContain("Upgrade helper invoked");
});

it("serializes maintenance and routes an interrupted upgrade to recovery", async () => {
  const f = await fixture();
  expect((await f.install()).code).toBe(0);
  await writeFile(join(f.destination, ".nimbot-upgrade.json"), "{}");
  const before = await f.readState();
  const refused = await f.run("uninstall", [], []);
  expect(refused.code).not.toBe(0);
  expect(refused.output).toContain("An upgrade is pending");
  const owner = (
    await readFile(join(f.destination, ".nimbot-installation"), "utf8")
  ).split("\n")[0];
  await writeFile(
    join(f.destination, ".nimbot-upgrade-helper"),
    `nimbot-upgrade-${owner}:v1.0.0\n`,
  );
  await symlink(
    String(process.pid),
    join(f.destination, ".nimbot-maintenance"),
  );
  const busy = await f.run("upgrade", [], ["--rollback"]);
  expect(busy.code).not.toBe(0);
  expect(busy.output).toContain("maintenance is still running");
  await rm(join(f.destination, ".nimbot-maintenance"));
  const resumed = await f.run("upgrade", [], ["--rollback"]);
  expect(resumed.code).toBe(0);
  expect(resumed.output).toContain("Upgrade helper invoked");
  expect(await f.readState()).toEqual(before);
});
