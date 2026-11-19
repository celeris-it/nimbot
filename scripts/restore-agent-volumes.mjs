import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const execute = (command, args) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", command === "tar" ? "ignore" : "pipe", "pipe"],
  });

// Administrator-operated restore only; never invoked by an agent or the Server.
export function restoreAgentVolumes(
  backup,
  agentId,
  installationId,
  run = execute,
) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(agentId ?? ""))
    throw new Error("Provide the saved agent ID, not its display name.");
  if (!/^(?:[a-f0-9]{32}|manual)$/.test(installationId ?? ""))
    throw new Error("Provide the restored NIMBOT_INSTALLATION_ID.");
  const directory = realpathSync(backup);
  // Docker's --mount CSV syntax cannot represent this path without quoting.
  if (directory.includes(",") || directory.includes("\n"))
    throw new Error(
      "The backup directory must not contain commas or newlines.",
    );
  const volumes = ["workspace", "engine", "tasks"].map(
    (kind) => `nimbot-${agentId}-${kind}`,
  );
  for (const name of volumes) {
    const archive = join(directory, `${name}.tar.gz`);
    if (!statSync(archive).isFile())
      throw new Error(`Missing archive: ${name}`);
    run("tar", ["-tzf", archive]);
  }
  const existing = new Set(
    run("docker", ["volume", "ls", "--format", "{{.Name}}"]).trim().split("\n"),
  );
  for (const name of volumes) {
    if (existing.has(name)) {
      // Inspection failures must also abort; never interpret them as absence.
      run("docker", ["volume", "inspect", name]);
      throw new Error(
        `Volume ${name} already exists. Inspect and preserve it; restore requires unused volume names.`,
      );
    }
  }
  const operation = randomUUID();
  const labels = {
    "io.nimbot.agent-id": agentId,
    "io.nimbot.installation": installationId,
    "io.nimbot.restore-operation": operation,
  };
  function inspect(name) {
    const [volume] = JSON.parse(run("docker", ["volume", "inspect", name]));
    if (
      volume?.Name !== name ||
      volume.Driver !== "local" ||
      Object.entries(labels).some(
        ([key, value]) => volume.Labels?.[key] !== value,
      ) ||
      Object.keys(volume.Options ?? {}).length
    )
      throw new Error(
        `Conflicting volume ${name}; no archive was extracted into it.`,
      );
  }
  // Create and verify the entire set before extracting any archive. The attempt
  // label detects Docker's idempotent create adopting a concurrently created volume.
  for (const name of volumes) {
    run("docker", [
      "volume",
      "create",
      "--driver",
      "local",
      ...Object.entries(labels).flatMap(([key, value]) => [
        "--label",
        `${key}=${value}`,
      ]),
      name,
    ]);
    inspect(name);
  }
  for (const name of volumes) {
    inspect(name);
    run("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "0:0",
      "--mount",
      `type=volume,src=${name},dst=/data,volume-nocopy`,
      "--mount",
      `type=bind,src=${directory},dst=/backup,readonly`,
      "node:22-bookworm-slim",
      "tar",
      "--numeric-owner",
      "--same-owner",
      "-xzpf",
      `/backup/${name}.tar.gz`,
      "-C",
      "/data",
    ]);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 5)
      throw new Error(
        "Usage: node scripts/restore-agent-volumes.mjs BACKUP_DIRECTORY AGENT_ID INSTALLATION_ID",
      );
    restoreAgentVolumes(...process.argv.slice(2));
    process.stdout.write(
      "Restored all three agent volumes. No agent container was started.\n",
    );
  } catch (error) {
    process.stderr.write(
      `Restore stopped: ${error.message}\nRetained volumes are not removed automatically. Inspect them before retrying.\n`,
    );
    process.exitCode = 1;
  }
}
