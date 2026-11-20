import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  agentContainerSpec,
  agentResourceNames,
} from "../apps/server/src/container-resources.js";

const helper = process.env.NIMBOT_TEST_UPGRADE_HELPER;
const serverImage = process.env.NIMBOT_TEST_UPGRADE_SERVER;
const hostImage = process.env.NIMBOT_TEST_UPGRADE_HOST;
const sourceServer = process.env.NIMBOT_TEST_UPGRADE_SOURCE_SERVER;
const sourceHost = process.env.NIMBOT_TEST_UPGRADE_SOURCE_HOST;
const state = "/home/node/.local/share/nimbot";
const label = "io.nimbot.installation";
const agentLabel = "io.nimbot.agent-id";
const version = "v1.0.0";

it.skipIf(!helper || !serverImage || !hostImage)(
  "rolls back a failed adoption and upgrades both Agent Hosts while preserving their data and running state",
  async () => {
    const id = randomBytes(16).toString("hex");
    const project = `nimbot-${id}`;
    const server = `nimbot-upgrade-test-${id}`;
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "nimbot-upgrade-")),
    );
    const target = join(directory, ".nimbot-releases", version);
    const serverVolume = `${project}_server-state`;
    const invalid = `nimbot-${id}-orphan-tasks`;
    const tags = [
      `nimbot-upgrade-test-${id}:old-server`,
      `nimbot-upgrade-test-${id}:old-host`,
    ];
    const command = (args: string[], input?: string) =>
      execFileSync("docker", args, {
        input,
        encoding: "utf8",
        timeout: 180_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    const named = (kind: string, flag: string) =>
      command([kind, "ls", flag, "--filter", `label=${label}=${id}`])
        .split("\n")
        .filter(Boolean);
    const inspect = (ref: string, field: string) =>
      command(["container", "inspect", "--format", field, ref]);
    const image = (ref: string) =>
      command(["image", "inspect", "--format", "{{.Id}}", ref]);
    const code = (ref: string, source: string, ...args: string[]) =>
      command([
        "exec",
        ref,
        "node",
        "--input-type=module",
        "-e",
        source,
        ...args,
      ]);
    async function waitForPanel() {
      for (let attempt = 0; ; attempt++) {
        try {
          code(
            server,
            `process.exit((await fetch("http://127.0.0.1:3000/login")).ok ? 0 : 1)`,
          );
          break;
        } catch (error) {
          if (attempt === 20) throw error;
          await delay(250);
        }
      }
    }
    const oldAgents = new Map<
      string,
      { ref: string; token: string; volume: string; credential: string }
    >();
    try {
      const endpoint =
        process.env.DOCKER_HOST ||
        command([
          "context",
          "inspect",
          "--format",
          "{{.Endpoints.docker.Host}}",
        ]);
      expect(endpoint).toMatch(/^unix:\/\//);
      const socket = endpoint.slice("unix://".length);
      const gid = command([
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${socket}:/var/run/docker.sock:ro`,
        helper!,
        "stat",
        "-c",
        "%g",
        "/var/run/docker.sock",
      ]);
      const envPath = join(directory, ".env");
      mkdirSync(target, { recursive: true });
      copyFileSync("release.json", join(target, "release.json"));
      const compose = readFileSync("compose.yaml", "utf8").replace(
        "127.0.0.1:3000:3000",
        "127.0.0.1:0:3000",
      );
      for (const path of [directory, target])
        writeFileSync(join(path, "compose.yaml"), compose);
      command(
        ["build", "-t", tags[0]!, "-"],
        `FROM ${sourceServer ?? serverImage}\nLABEL nimbot.upgrade.fixture=old-server\n`,
      );
      command(
        ["build", "-t", tags[1]!, "-"],
        `FROM ${sourceHost ?? hostImage}\nLABEL nimbot.upgrade.fixture=old-host\n`,
      );
      const env = [
        `NIMBOT_INSTALLATION_ID=${id}`,
        `SERVER_CONTAINER_NAME=${server}`,
        `DOCKER_SOCKET_PATH=${socket}`,
        `DOCKER_SOCKET_GID=${gid}`,
        `PANEL_PASSWORD_HASH=scrypt:${"a".repeat(32)}:${"b".repeat(128)}`,
        "PANEL_URL=http://localhost:3000",
        `NIMBOT_SERVER_IMAGE=${tags[0]}`,
        `AGENT_HOST_IMAGE=${tags[1]}`,
        "",
      ].join("\n");
      writeFileSync(envPath, env, { mode: 0o600 });
      writeFileSync(
        join(directory, ".nimbot-installation"),
        `${id}\n${socket}\n`,
      );
      try {
        command([
          "compose",
          "--project-name",
          project,
          "--env-file",
          envPath,
          "-f",
          join(directory, "compose.yaml"),
          "up",
          "-d",
          "--no-build",
          "--wait",
          "--wait-timeout",
          "120",
        ]);
      } catch (error) {
        const logs = spawnSync("docker", ["logs", server], {
          encoding: "utf8",
        });
        throw new Error(`${logs.stdout}${logs.stderr}`, { cause: error });
      }
      const oldServer = inspect(server, "{{.Id}}");
      for (const running of [true, false]) {
        const agent = `${id}-${running ? "on" : "off"}`;
        const names = agentResourceNames(agent);
        const labels = { [label]: id, [agentLabel]: agent };
        const network = command([
          "network",
          "create",
          "--internal",
          "--label",
          `${label}=${id}`,
          "--label",
          `${agentLabel}=${agent}`,
          names.network,
        ]);
        const token = randomBytes(32).toString("hex");
        const credential = `host-${randomUUID()}`;
        for (const volume of names.volumes)
          command([
            "volume",
            "create",
            "--label",
            `${label}=${id}`,
            "--label",
            `${agentLabel}=${agent}`,
            volume,
          ]);
        command(["network", "connect", network, server]);
        const spec = agentContainerSpec(
          { image: image(tags[1]!) },
          names.volumes,
          network,
          token,
          labels,
        );
        // Use the production Docker payload, without starting the stopped fixture.
        const ref = JSON.parse(
          code(
            server,
            `
          import { request } from "node:http";
          const [name, payload] = process.argv.slice(1);
          const req = request({ socketPath: "/var/run/docker.sock",
            path: "/v1.47/containers/create?name=" + encodeURIComponent(name), method: "POST",
            headers: { "Content-Type": "application/json" } },
            (res) => res.pipe(process.stdout));
          req.end(payload);
        `,
            names.container,
            JSON.stringify(spec),
          ),
        ).Id as string;
        expect(ref).toMatch(/^[a-f0-9]{64}$/);
        oldAgents.set(agent, {
          ref,
          token,
          volume: names.volumes[2]!,
          credential,
        });
        code(
          server,
          `
          import { DatabaseSync } from "node:sqlite";
          import { writeFileSync } from "node:fs";
          const [state, id, ref, network, workspace, credential, token, legacy] = process.argv.slice(1);
          const db = new DatabaseSync(state + "/server.sqlite");
          db.prepare("INSERT INTO agents (id, name, owner_id, container_ref) VALUES (?, ?, 1, ?)").run(id, id, ref);
          db.prepare("INSERT INTO agent_provisioning (agent_id, status, volume_ref, network_ref, updated_at) VALUES (?, 'ready', ?, ?, 1)").run(id, workspace, network);
          db.prepare("INSERT INTO agent_host_credentials (agent_id, credential_ref) VALUES (?, ?)").run(id, "file:" + credential);
          if (legacy === "legacy") db.exec("PRAGMA user_version = 0");
          writeFileSync(state + "/host-secrets/" + credential, token, { mode: 0o600 });
        `,
          state,
          agent,
          ref,
          network,
          names.volumes[0]!,
          credential,
          token,
          sourceServer ? "legacy" : "current",
        );
        if (running) {
          command(["start", ref]);
          for (let attempt = 0; ; attempt++) {
            try {
              code(
                ref,
                `
                import { DatabaseSync } from "node:sqlite";
                import { writeFileSync, existsSync } from "node:fs";
                const state = process.argv[1];
                if (!existsSync(state + "/memory.sqlite")) process.exit(1);
                const tasks = new DatabaseSync(state + "/tasks.sqlite");
                tasks.exec("INSERT INTO tasks (id,prompt,status) VALUES ('t','saved prompt','completed'); PRAGMA user_version = 0");
                const memory = new DatabaseSync(state + "/memory.sqlite");
                memory.exec("INSERT INTO memories (id,title,content,tags,created_at,updated_at) VALUES ('m','saved note','body','[]',1,1); PRAGMA user_version = 0");
                writeFileSync("/workspace/saved.txt", "workspace data");
                writeFileSync("/home/node/.local/share/opencode/saved.txt", "provider state");
              `,
                state,
              );
              break;
            } catch (error) {
              if (attempt === 20) throw error;
              await delay(250);
            }
          }
        }
      }
      command(["volume", "create", "--label", `${label}=${id}`, invalid]);
      command([
        "run",
        "--rm",
        "--user",
        "0",
        "--mount",
        `type=volume,source=${invalid},target=/state`,
        helper!,
        "node",
        "--input-type=module",
        "-e",
        `import { DatabaseSync } from "node:sqlite";
          import { chownSync } from "node:fs";
          const db = new DatabaseSync("/state/tasks.sqlite"); db.exec("CREATE TABLE old (id TEXT)"); db.close();
          chownSync("/state", 1000, 1000); chownSync("/state/tasks.sqlite", 1000, 1000);`,
      ]);
      const upgrade = () =>
        command([
          "run",
          "--rm",
          "--network",
          "none",
          "--user",
          `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
          "--group-add",
          String(gid),
          "-e",
          "HOME=/tmp",
          "-e",
          "DOCKER_HOST=unix:///var/run/docker.sock",
          "-v",
          `${socket}:/var/run/docker.sock`,
          "-v",
          `${directory}:/installation`,
          helper!,
          "node",
          "/app/scripts/upgrade.mjs",
          id,
          version,
          helper!,
          serverImage!,
          image(hostImage!),
        ]);
      expect(upgrade).toThrow(
        /Schema differs[\s\S]*returned to the previous version/,
      );
      expect(inspect(server, "{{.Id}}")).toBe(oldServer);
      expect(inspect(server, "{{.State.Running}}")).toBe("true");
      await waitForPanel();
      expect(
        code(
          server,
          `import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.argv[1]); console.log(db.prepare("PRAGMA user_version").get().user_version);`,
          `${state}/server.sqlite`,
        ),
      ).toBe(sourceServer ? "0" : "2");
      for (const [agent, { ref }] of oldAgents) {
        expect(inspect(`nimbot-${agent}`, "{{.Id}}")).toBe(ref);
        expect(inspect(ref, "{{.State.Running}}")).toBe(
          String(agent.endsWith("-on")),
        );
      }

      command(["volume", "rm", invalid]);
      const targetCompose = join(target, "compose.yaml");
      writeFileSync(
        targetCompose,
        compose.replace(
          "  server:\n",
          "  server:\n    runtime: nimbot-fixture-missing-runtime\n",
        ),
      );
      if (sourceServer)
        code(
          server,
          `import { DatabaseSync } from "node:sqlite"; new DatabaseSync(process.argv[1]).exec("PRAGMA user_version = 0");`,
          `${state}/server.sqlite`,
        );
      // Force a failure after Hosts have been replaced and the original Server has been removed.
      expect(upgrade).toThrow(
        /Docker compose[\s\S]*returned to the previous version/,
      );
      const restoredServer = inspect(server, "{{.Id}}");
      expect(restoredServer).not.toBe(oldServer);
      await waitForPanel();
      for (const [agent, { ref }] of oldAgents) {
        expect(inspect(`nimbot-${agent}`, "{{.Id}}")).toBe(ref);
        expect(inspect(ref, "{{.State.Running}}")).toBe(
          String(agent.endsWith("-on")),
        );
      }
      writeFileSync(targetCompose, compose);
      // Restore the unversioned marker after the fixture's previous runtime reopened the database.
      if (sourceServer)
        code(
          server,
          `import { DatabaseSync } from "node:sqlite"; new DatabaseSync(process.argv[1]).exec("PRAGMA user_version = 0");`,
          `${state}/server.sqlite`,
        );
      expect(upgrade()).toContain(`Nimbot ${version} is active`);
      expect(inspect(server, "{{.Id}}")).not.toBe(restoredServer);
      expect(
        readFileSync(join(directory, ".nimbot-release"), "utf8").trim(),
      ).toBe(version);
      expect(readFileSync(envPath, "utf8")).toBe(env);
      for (const [agent, { ref, token, volume, credential }] of oldAgents) {
        const name = `nimbot-${agent}`;
        const replacement = inspect(name, "{{.Id}}");
        const running = agent.endsWith("-on");
        expect(replacement).not.toBe(ref);
        expect(inspect(name, "{{.Image}}")).toBe(image(hostImage!));
        expect(inspect(name, "{{.State.Running}}")).toBe(String(running));
        expect(inspect(name, "{{range .Mounts}}{{.Name}} {{end}}")).toContain(
          volume,
        );
        expect(
          code(
            server,
            `
          import { readFileSync } from "node:fs";
          import { DatabaseSync } from "node:sqlite";
          const [state, id, cred] = process.argv.slice(1);
          const db = new DatabaseSync(state + "/server.sqlite");
          console.log(JSON.stringify([db.prepare("SELECT container_ref FROM agents WHERE id=?").get(id).container_ref,
            readFileSync(state + "/host-secrets/" + cred, "utf8")]));
        `,
            state,
            agent,
            credential,
          ),
        ).toBe(JSON.stringify([replacement, token]));
        if (running) {
          expect(
            code(
              name,
              `
            import { readFileSync } from "node:fs";
            import { DatabaseSync } from "node:sqlite";
            const state = process.argv[1];
            console.log(JSON.stringify([
              new DatabaseSync(state + "/tasks.sqlite").prepare("SELECT prompt FROM tasks WHERE id='t'").get().prompt,
              new DatabaseSync(state + "/memory.sqlite").prepare("SELECT title FROM memories WHERE id='m'").get().title,
              readFileSync("/workspace/saved.txt", "utf8"), readFileSync("/home/node/.local/share/opencode/saved.txt", "utf8")
            ]));
          `,
              state,
            ),
          ).toBe(
            JSON.stringify([
              "saved prompt",
              "saved note",
              "workspace data",
              "provider state",
            ]),
          );
        }
      }
      expect(
        command(["volume", "inspect", "--format", "{{.Name}}", serverVolume]),
      ).toBe(serverVolume);
      expect(upgrade()).toContain("already installed");
    } finally {
      for (const [kind, flag, options] of [
        ["container", "-aq", ["-f"]],
        ["network", "-q", []],
        ["volume", "-q", []],
      ] as const) {
        const resources = named(kind, flag);
        if (resources.length) command([kind, "rm", ...options, ...resources]);
      }
      const backups = command([
        "image",
        "ls",
        "--format",
        "{{.Repository}}:{{.Tag}}",
        "--filter",
        `reference=nimbot-upgrade-backup-${id}:*`,
      ])
        .split("\n")
        .filter(Boolean);
      for (const tag of [...backups, ...tags])
        try {
          command(["image", "rm", tag]);
        } catch {
          /* A build may have failed before tagging. */
        }
      rmSync(directory, { recursive: true, force: true });
    }
  },
  240_000,
);
