import process from "node:process";
import console from "node:console";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  agentContainerSpec,
  agentResourceNames,
} from "../apps/server/dist/container-resources.js";
import { createDockerApi } from "../apps/server/dist/docker-api.js";
import { docker, inspect, listing, compose } from "./upgrade-docker.mjs";

const [installation, version, helper, serverImage, hostImage] =
  process.argv.slice(2);
process.umask(0o077);
const root = "/installation";
const project = `nimbot-${installation}`;
const ownership = "io.nimbot.installation";
const agentLabel = "io.nimbot.agent-id";
const upgradeLabel = "io.nimbot.upgrade";
const stateVolume = `${project}_server-state`;
const versionFile = `${root}/.nimbot-release`;
const journal = `${root}/.nimbot-upgrade.json`;
const tag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const api = createDockerApi(process.env.DOCKER_HOST.slice("unix://".length));
let interrupted = false;
let recovering = false;
process.on("SIGINT", () => {
  interrupted = true;
});
process.on("SIGTERM", () => {
  interrupted = true;
});

function checkInterrupt() {
  if (interrupted && !recovering) throw new Error("Upgrade interrupted.");
}

function atomic(path, data) {
  writeFileSync(`${path}.tmp`, data, { mode: 0o600, flush: true });
  renameSync(`${path}.tmp`, path);
  syncDirectory(path.slice(0, path.lastIndexOf("/")));
}

function syncDirectory(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function save(tx) {
  atomic(journal, JSON.stringify(tx));
}

function installed() {
  if (!existsSync(versionFile)) return "legacy-main";
  return readFileSync(versionFile, "utf8").trim();
}

function newer(target, previous) {
  const parts = (value) => value.slice(1).split(".").map(BigInt);
  const before = parts(previous);
  const after = parts(target);
  const first = after.findIndex((value, index) => value !== before[index]);
  return first >= 0 && after[first] > before[first];
}

function source(release) {
  const staged = `${root}/.nimbot-releases/${release}`;
  return tag.test(release) && existsSync(staged) ? staged : root;
}

function owned(kind, ref, expectedAgent) {
  const item = inspect(kind, ref);
  const labels = kind === "container" ? item.Config.Labels : item.Labels;
  if (
    labels?.[ownership] !== installation ||
    (expectedAgent && labels[agentLabel] !== expectedAgent)
  )
    throw new Error(`Refusing foreign ${kind} ${ref}.`);
  return item;
}

function server(optional = false) {
  const refs = listing("container", `com.docker.compose.project=${project}`)
    .map((ref) => inspect("container", ref))
    .filter(
      (item) => item.Config.Labels?.["com.docker.compose.service"] === "server",
    );
  if (optional && refs.length === 0) return;
  if (refs.length !== 1)
    throw new Error("Expected one managed Server container.");
  const [item] = refs;
  if (
    item.Config.Labels?.[ownership] !== installation ||
    item.Config.Labels["com.docker.compose.project"] !== project ||
    !item.Mounts.some(
      (mount) =>
        mount.Type === "volume" &&
        mount.Name === stateVolume &&
        mount.Destination === "/home/node/.local/share/nimbot",
    )
  )
    throw new Error("The Server does not match the managed installation.");
  return item;
}

function envValue(container, key) {
  return container.Config.Env.find((entry) =>
    entry.startsWith(`${key}=`),
  )?.slice(key.length + 1);
}

function volumeRun(volume, mode, ...command) {
  owned("volume", volume);
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    ...(mode === "ro" ? ["--cap-add", "DAC_OVERRIDE"] : []),
    "--mount",
    `type=volume,source=${volume},destination=/state${mode === "ro" ? ",readonly" : ""},volume-nocopy`,
    helper,
    ...command,
  ];
}

function state(volume, mode, action, args = [], input) {
  const run = volumeRun(
    volume,
    mode,
    "node",
    "--no-warnings",
    "/app/scripts/upgrade-state.mjs",
    action,
    ...args,
  );
  run.splice(
    1,
    0,
    "--user",
    "1000:1000",
    ...(input === undefined ? [] : ["-i"]),
  );
  try {
    return docker(run, { state: true, input });
  } catch (error) {
    throw new Error(`${volume} (${action}): ${error.message}`, {
      cause: error,
    });
  }
}

function archive(volume, path, restore) {
  const run = volumeRun(
    volume,
    restore ? "rw" : "ro",
    ...(restore
      ? [
          "sh",
          "-ec",
          "find /state -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar --numeric-owner --same-owner -xzpf - -C /state && sync -f /state",
        ]
      : [
          "tar",
          "--numeric-owner",
          "--sparse",
          "-czf",
          "-",
          "-C",
          "/state",
          ".",
        ]),
  );
  if (restore)
    run.splice(
      1,
      0,
      "-i",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "FOWNER",
      "--cap-add",
      "FSETID",
    );
  const fd = openSync(path, restore ? "r" : "wx", 0o600);
  try {
    const result = spawnSync("docker", run, {
      stdio: restore ? [fd, "ignore", "ignore"] : ["ignore", fd, "ignore"],
    });
    if (result.status !== 0)
      throw new Error(
        `Could not ${restore ? "restore" : "back up"} volume ${volume}.`,
      );
    if (!restore) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!restore) verifyArchive(volume, path);
}

function verifyArchive(volume, path) {
  for (const [tool, args] of [
    ["gzip", ["-t", path]],
    ["tar", ["-tzf", path]],
  ]) {
    if (spawnSync(tool, args, { stdio: "ignore" }).status !== 0)
      throw new Error(`Could not verify backup of volume ${volume}.`);
  }
}

function availableVolumes() {
  return listing("volume", `${ownership}=${installation}`).map((name) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name))
      throw new Error("Invalid owned volume name.");
    return owned("volume", name);
  });
}

function currentHosts() {
  return listing("container", `${ownership}=${installation}`)
    .map((ref) => owned("container", ref))
    .filter((item) => item.Config.Labels[agentLabel]);
}

function snapshotHosts(items) {
  return items.map((item) => ({
    ref: item.Id,
    name: item.Name.slice(1),
    running: item.State.Running,
    image: item.Image,
  }));
}

function assertStopped(ref) {
  if (inspect("container", ref).State.Running)
    docker(["container", "stop", "--time", "45", ref]);
}

function start(ref) {
  if (!inspect("container", ref).State.Running)
    docker(["container", "start", ref]);
}

function reconnect(ref, networks) {
  for (const network of networks) {
    owned("network", network);
    const attached = Object.values(
      inspect("container", ref).NetworkSettings.Networks,
    ).some((item) => item.NetworkID === network);
    if (!attached) docker(["network", "connect", network, ref]);
  }
}

function additionalNetworks(container) {
  return Object.keys(container.NetworkSettings.Networks)
    .filter((name) => name !== `${project}_default`)
    .map((name) => owned("network", name).Id);
}

function previousCompose(tx) {
  const override = `${tx.backup}/rollback-compose.json`;
  atomic(
    override,
    JSON.stringify({ services: { server: { image: tx.serverImageBackup } } }),
  );
  return compose(
    project,
    source(tx.from),
    {
      NIMBOT_SERVER_IMAGE: tx.serverImageBackup,
      NIMBOT_UPGRADE_TOKEN: tx.previousToken ?? "",
      ...(tx.previousHostImage
        ? { AGENT_HOST_IMAGE: tx.previousHostImage }
        : {}),
    },
    ["create", "--no-build", "server"],
    override,
  );
}

async function resumePrevious(tx) {
  let current = server(true);
  if (!current) {
    previousCompose(tx);
    current = server();
  }
  reconnect(current.Id, tx.networks);
  for (const host of tx.hosts)
    if (host.running && inspect("container", host.ref, true))
      start(owned("container", host.ref).Id);
  if (tx.serverRunning) {
    start(current.Id);
    await waitForPanel(current.Id);
  }
}

async function rollback(tx) {
  if (tx.phase !== "restored") {
    const current = server(true);
    if (current) {
      assertStopped(current.Id);
      if (current.Id !== tx.serverRef) docker(["container", "rm", current.Id]);
    }
    for (const ref of listing("container", `${upgradeLabel}=${tx.token}`)) {
      const replacement = owned("container", ref);
      if (!replacement.Config.Labels[agentLabel])
        throw new Error("Unexpected replacement container.");
      assertStopped(replacement.Id);
      docker(["container", "rm", replacement.Id]);
    }
    if (tx.phase === "changing") {
      for (const host of tx.hosts) {
        const old = owned("container", host.ref);
        assertStopped(old.Id);
        if (old.Name !== `/${host.name}`)
          docker(["container", "rename", old.Id, host.name]);
      }
      for (const volume of tx.volumes)
        verifyArchive(volume, `${tx.backup}/${volume}.tar.gz`);
      for (const volume of tx.volumes)
        archive(volume, `${tx.backup}/${volume}.tar.gz`, true);
      atomic(`${root}/.env`, readFileSync(`${tx.backup}/env.backup`));
      atomic(
        `${root}/.nimbot-installation`,
        readFileSync(`${tx.backup}/installation.backup`),
      );
      if (tx.from === "legacy-main") rmSync(versionFile, { force: true });
      else atomic(versionFile, `${tx.from}\n`);
    }
    tx.phase = "restored";
    save(tx);
  }
  await resumePrevious(tx);
  finishJournal();
  process.stdout.write("Previous Nimbot deployment restored.\n");
}

function finishJournal() {
  rmSync(journal);
  syncDirectory(root);
}

async function finishActivation(tx) {
  // This phase is the point of no return. A retry can finish activation and
  // cleanup without restoring an older snapshot over newly accepted work.
  const current = server();
  if (current.Id !== tx.targetServerRef)
    throw new Error("The committed Server container has changed.");
  start(current.Id);
  state(stateVolume, "rw", "activate", [tx.token]);
  await waitForPanel(current.Id);
  for (const host of tx.hosts) {
    const old = inspect("container", host.ref, true);
    if (old && old.Name === `/${host.name}-previous-${tx.token.slice(0, 8)}`) {
      owned("container", old.Id);
      docker(["container", "rm", old.Id]);
    }
  }
  finishJournal();
  process.stdout.write(
    `Nimbot ${tx.to} is active. Backup: ${tx.backup.replace(root, ".")}\n`,
  );
}

function inventory(tx) {
  const expected = JSON.parse(state(stateVolume, "ro", "agents"));
  const hosts = currentHosts();
  if (
    hosts.some((item) => !expected.some((agent) => agent.container === item.Id))
  )
    throw new Error(
      "An owned Agent Host is untracked. Reconcile its resources and retry.",
    );
  return expected
    .filter((agent) => agent.container)
    .map((agent) => {
      checkInterrupt();
      const names = agentResourceNames(agent.id);
      const item = owned("container", agent.container, agent.id);
      if (
        item.Name !== `/${names.container}` ||
        agent.workspace !== names.volumes[0]
      )
        throw new Error(
          `Agent ${agent.id} has inconsistent container or workspace references.`,
        );
      const network = owned("network", agent.network, agent.id);
      if (
        network.Name !== names.network ||
        network.Driver !== "bridge" ||
        item.HostConfig.NetworkMode !== network.Id
      )
        throw new Error(`Agent ${agent.id} has an unexpected network.`);
      const mounts = agentContainerSpec(
        { image: hostImage },
        names.volumes,
        network.Id,
        "",
        {},
      ).HostConfig.Mounts;
      if (
        mounts.length !== item.Mounts.length ||
        mounts.some(
          (mount) =>
            !item.Mounts.some(
              (actual) =>
                actual.Type === "volume" &&
                actual.RW &&
                actual.Name === mount.Source &&
                actual.Destination === mount.Target,
            ) || !owned("volume", mount.Source, agent.id),
        )
      )
        throw new Error(`Agent ${agent.id} has unexpected mounts.`);
      const prior = tx.hosts.find((entry) => entry.ref === item.Id);
      const timeout = envValue(item, "TASK_TIMEOUT_SECONDS");
      if (timeout && !/^[1-9]\d*$/.test(timeout))
        throw new Error(`Agent ${agent.id} has an invalid task timeout.`);
      return {
        ...agent,
        name: names.container,
        volumes: names.volumes,
        network: network.Id,
        running: prior.running,
        timeout: timeout ? Number(timeout) : undefined,
        labels: item.Config.Labels,
      };
    });
}

async function replaceHost(agent, tx) {
  checkInterrupt();
  const token = state(stateVolume, "ro", "token", [agent.credential]);
  docker([
    "container",
    "rename",
    agent.container,
    `${agent.name}-previous-${tx.token.slice(0, 8)}`,
  ]);
  const response = await api(
    `/containers/create?name=${encodeURIComponent(agent.name)}`,
    "POST",
    agentContainerSpec(
      { image: hostImage, taskTimeoutSeconds: agent.timeout },
      agent.volumes,
      agent.network,
      token,
      { ...agent.labels, [upgradeLabel]: tx.token },
    ),
  );
  if (response.code !== 201)
    throw new Error(`Could not replace Agent Host ${agent.id}.`);
  const { Id: after } = JSON.parse(response.body);
  if (owned("container", after, agent.id).Image !== hostImage)
    throw new Error(`Unexpected target image for Agent Host ${agent.id}.`);
  return { id: agent.id, before: agent.container, after };
}

async function ready(id, code, args = []) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    checkInterrupt();
    const result = spawnSync(
      "docker",
      ["exec", id, "node", "--input-type=module", "-e", code, ...args],
      { stdio: "ignore", timeout: 6000 },
    );
    if (result.status === 0) return;
    await delay(1000);
  }
  throw new Error(`Readiness check failed for ${args[0] ?? "the Server"}.`);
}

function waitForPanel(id) {
  return ready(
    id,
    `
    const response = await fetch("http://127.0.0.1:3000/login", { signal: AbortSignal.timeout(3000) });
    process.exit(response.ok ? 0 : 1);
  `,
  );
}

function checkSpace(volumes) {
  const estimate = volumes.reduce(
    (total, { Name }) =>
      total +
      BigInt(
        docker(volumeRun(Name, "ro", "du", "-sbx", "/state")).split(/\s+/)[0],
      ) *
        2n,
    0n,
  );
  const disk = statfsSync(root, { bigint: true });
  if (disk.bavail * disk.bsize < estimate)
    throw new Error("Insufficient free space for the pre-upgrade backup.");
}

async function upgrade() {
  const from = installed();
  if (from === version) {
    process.stdout.write(`Nimbot ${version} is already installed.\n`);
    return;
  }
  if (from !== "legacy-main" && !tag.test(from))
    throw new Error("This installation was built from development source.");
  if (tag.test(from) && !newer(version, from))
    throw new Error("The target must be newer than the installed release.");
  const target = source(version);
  const { upgradeFrom } = JSON.parse(
    readFileSync(`${target}/release.json`, "utf8"),
  );
  if (upgradeFrom !== from)
    throw new Error(
      `Nimbot ${version} requires ${upgradeFrom}; this installation is ${from}.`,
    );

  const newServer = inspect("image", serverImage).Id;
  if (inspect("image", hostImage).Id !== hostImage)
    throw new Error("Agent Host image must be pinned by ID.");
  const newEnv = {
    NIMBOT_SERVER_IMAGE: serverImage,
    AGENT_HOST_IMAGE: hostImage,
  };
  const old = server();
  const config = JSON.parse(
    compose(project, target, newEnv, ["config", "--format", "json"]),
  );
  if (
    config.services.server.container_name !== old.Name.slice(1) ||
    config.services.server.labels[ownership] !== installation ||
    config.volumes["server-state"].name !== stateVolume
  )
    throw new Error(
      "Target Compose configuration would change the installation identity or Server resources.",
    );
  const volumes = availableVolumes();
  checkSpace(volumes);
  checkInterrupt();

  const token = randomUUID();
  const backup = `${root}/.nimbot-backups/${token}`;
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  const serverImageBackup = `nimbot-upgrade-backup-${installation}:server-${token}`;
  docker(["image", "tag", old.Image, serverImageBackup]);
  const previousHostImage = envValue(old, "AGENT_HOST_IMAGE");
  const previousHostId =
    previousHostImage && inspect("image", previousHostImage).Id;
  if (previousHostId)
    docker([
      "image",
      "tag",
      previousHostId,
      `nimbot-upgrade-backup-${installation}:host-${token}`,
    ]);
  const tx = {
    phase: "stopping",
    from,
    to: version,
    backup,
    token,
    serverRef: old.Id,
    serverRunning: old.State.Running,
    serverImageBackup,
    previousHostImage: previousHostId,
    previousToken: envValue(old, "NIMBOT_UPGRADE_TOKEN"),
    networks: additionalNetworks(old),
    hosts: snapshotHosts(currentHosts()),
    volumes: [],
  };
  save(tx);

  try {
    assertStopped(old.Id);
    // The Server might have completed a lifecycle operation before it stopped.
    tx.hosts = snapshotHosts(currentHosts());
    tx.networks = additionalNetworks(server());
    tx.volumes = availableVolumes().map(({ Name }) => Name);
    save(tx);
    const agentImages = [...new Set(tx.hosts.map(({ image }) => image))];
    for (const [index, image] of agentImages.entries())
      docker([
        "image",
        "tag",
        image,
        `nimbot-upgrade-backup-${installation}:agent-${index}-${token}`,
      ]);
    for (const host of tx.hosts) {
      checkInterrupt();
      assertStopped(host.ref);
    }
    for (const volume of tx.volumes) {
      checkInterrupt();
      if (docker(["container", "ls", "-q", "--filter", `volume=${volume}`]))
        throw new Error(
          `Volume ${volume} is still mounted by a running container.`,
        );
      archive(volume, `${backup}/${volume}.tar.gz`, false);
    }
    atomic(`${backup}/env.backup`, readFileSync(`${root}/.env`));
    atomic(
      `${backup}/installation.backup`,
      readFileSync(`${root}/.nimbot-installation`),
    );
    atomic(`${backup}/release.backup`, `${from}\n`);
    const agents = inventory(tx);
    atomic(
      `${backup}/deployment.json`,
      JSON.stringify({ ...tx, previousToken: undefined }),
    );
    tx.phase = "changing";
    save(tx);
    state(stateVolume, "rw", "schema", ["server", from]);
    for (const volume of tx.volumes.filter((name) => name.endsWith("-tasks"))) {
      checkInterrupt();
      for (const kind of ["tasks", "memory"])
        state(volume, "rw", "schema", [kind, from]);
    }
    const replacements = [];
    for (const agent of agents) replacements.push(await replaceHost(agent, tx));
    state(stateVolume, "rw", "replace", [], JSON.stringify(replacements));
    docker(["container", "rm", old.Id]);
    compose(project, target, { ...newEnv, NIMBOT_UPGRADE_TOKEN: token }, [
      "create",
      "--no-build",
      "server",
    ]);
    const replacement = server();
    if (replacement.Image !== newServer)
      throw new Error("Unexpected target Server image.");
    reconnect(replacement.Id, [
      ...new Set([...tx.networks, ...agents.map(({ network }) => network)]),
    ]);
    for (const agent of agents.filter(({ running }) => running))
      start(agent.name);
    start(replacement.Id);
    await ready(
      replacement.Id,
      `
      const r = await fetch("http://127.0.0.1:3000/_nimbot/upgrade-ready", {
        headers: { Authorization: "Bearer " + process.env.NIMBOT_UPGRADE_TOKEN },
        signal: AbortSignal.timeout(3000)
      });
      process.exit(r.status === 204 ? 0 : 1);
    `,
    );
    for (const { id, credential } of agents.filter(({ running }) => running))
      await ready(
        replacement.Id,
        `
        import { readFileSync } from "node:fs";
        import { getHostStatus } from "/app/apps/server/dist/agent-host.js";
        const [id, credential] = process.argv.slice(1);
        const token = readFileSync(process.env.SERVER_STATE_DIR + "/host-secrets/" + credential.slice(5), "utf8");
        process.exit(await getHostStatus({ url: "http://nimbot-" + id + ":3001", token }) === "ready" ? 0 : 1);
      `,
        [id, credential],
      );
    checkInterrupt();
    atomic(versionFile, `${version}\n`);
    tx.targetServerRef = replacement.Id;
    tx.phase = "committed";
    save(tx);
    await finishActivation(tx);
  } catch (error) {
    const saved = JSON.parse(readFileSync(journal, "utf8"));
    if (saved.phase !== "committed") {
      console.error(error.message);
      recovering = true;
      await rollback(saved);
      throw new Error(
        "Upgrade failed. Nimbot returned to the previous version.",
        { cause: error },
      );
    }
    throw error;
  }
}

try {
  if (version === "--rollback") {
    const tx = JSON.parse(readFileSync(journal, "utf8"));
    if (tx.phase === "committed") await finishActivation(tx);
    else await rollback(tx);
  } else {
    if (existsSync(journal))
      throw new Error(
        "An upgrade is pending. Run upgrade.sh --rollback to recover it.",
      );
    await upgrade();
  }
} catch (error) {
  console.error(error.message);
  if (existsSync(journal))
    console.error(
      "Recovery is pending. Run upgrade.sh --rollback with the same installation directory.",
    );
  process.exitCode = 1;
}
