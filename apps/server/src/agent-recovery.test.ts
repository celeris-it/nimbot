import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentRegistry } from "./agent-registry.js";
import { createAgentRecovery } from "./agent-recovery.js";
import {
  agentContainerSpec,
  agentResourceNames,
} from "./container-resources.js";
import type { DockerApi } from "./docker-api.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "nimbot-recovery-"));
  const path = join(directory, "server.sqlite");
  let registry = openAgentRegistry(path);
  const names = agentResourceNames("dev");
  const original = "a".repeat(64);
  const network = "b".repeat(64);
  const container = "c".repeat(64);
  const server = "d".repeat(64);
  const token = "e".repeat(64);
  const config = {
    socketPath: "/unused",
    image: `sha256:${"f".repeat(64)}`,
    installationId: "manual",
    serverContainerRef: "server",
  };
  registry.createPending({ id: "dev", name: "Dev", ownerId: 42 });
  registry.bindBot("dev", 123, "dev_bot");
  registry.setCredentialRef("dev", "file:telegram-saved");
  registry.beginProvisioning("dev");
  registry.setHostCredentialRef("dev", "file:host-saved");
  registry.recordProvisioningResources("dev", {
    containerRef: original,
    volumeRef: names.volumes[0],
    networkRef: "1".repeat(64),
  });
  registry.finishProvisioning("dev", "ready");
  const labels = {
    "io.nimbot.agent-id": "dev",
    "io.nimbot.installation": "manual",
  };
  const objects = new Map<string, unknown>([
    ["/containers/server/json", { Id: server, Config: { Labels: labels } }],
    ...names.volumes.map((name): [string, unknown] => [
      `/volumes/${name}`,
      { Name: name, Driver: "local", Options: null, Labels: labels },
    ]),
  ]);
  const mutations = [
    "/networks/create",
    `/networks/${network}/connect`,
    `/containers/create?name=${names.container}`,
  ];
  const posts: string[] = [];
  let loseResponse: string | undefined;
  let beforePost: (() => Promise<void>) | undefined;
  const networkPath = `/networks/${names.network}`;
  const containerPath = `/containers/${names.container}/json`;
  const call: DockerApi = async (url, method = "GET", body) => {
    if (method === "GET") {
      const data = objects.get(url);
      return data === undefined
        ? { code: 404, body: "" }
        : { code: 200, body: JSON.stringify(data) };
    }
    expect(method).toBe("POST");
    posts.push(url);
    const index = mutations.indexOf(url);
    const kind = (["network", "connection", "container"] as const)[index];
    expect(registry.getRecovery("dev")?.status).toBe("recovering");
    expect(
      registry.listRecoveryIntents("dev").find((entry) => entry.kind === kind)
        ?.resourceRef,
    ).toBeNull();
    await beforePost?.();
    if (index === 0) {
      const spec = body as { Name: string; Labels: object; Driver: string };
      const data = { Id: network, ...spec, Containers: {} };
      objects.set(networkPath, data);
      objects.set(`/networks/${network}`, data);
    } else if (index === 1) {
      expect(body).toEqual({ Container: server });
      Object.assign(objects.get(networkPath)!, {
        Containers: { [server]: {} },
      });
    } else if (index === 2) {
      const spec = body as ReturnType<typeof agentContainerSpec>;
      expect(spec).toMatchObject({
        Image: config.image,
        User: "1000:1000",
        HostConfig: { NetworkMode: network, Privileged: false },
      });
      expect(spec.Env).toContain(`AGENT_HOST_TOKEN=${token}`);
      const data = {
        Id: container,
        Name: `/${names.container}`,
        Config: spec,
        State: { Status: "created", Running: false },
        HostConfig: spec.HostConfig,
        Mounts: spec.HostConfig.Mounts.map((mount) => ({
          Type: mount.Type,
          Name: mount.Source,
          Destination: mount.Target,
        })),
      };
      objects.set(containerPath, data);
      objects.set(`/containers/${container}/json`, data);
    } else throw new Error("Unexpected mutation");
    if (url === loseResponse) throw new Error("Response lost");
    return { code: 201, body: "" };
  };
  return {
    get registry() {
      return registry;
    },
    names,
    labels,
    posts,
    mutations,
    objects,
    container,
    network,
    original,
    containerPath,
    service: () =>
      createAgentRecovery(
        registry,
        { read: async () => ({ url: "http://nimbot-dev:3001", token }) },
        config,
        call,
      ),
    lose(index: number) {
      loseResponse = mutations[index];
    },
    onPost(fn: () => Promise<void>) {
      beforePost = fn;
    },
    reopen() {
      registry.close();
      registry = openAgentRegistry(path);
    },
    close() {
      registry.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it.each([0, 1, 2])(
  "reconciles a lost response to mutation %s after restart without issuing it twice",
  async (index) => {
    const f = fixture();
    try {
      f.lose(index);
      await expect(f.service().recover("dev")).rejects.toThrow(
        "did not confirm",
      );
      expect(f.registry.get("dev")?.containerRef).toBe(f.original);
      f.reopen();
      await f.service().recover("dev");
      expect(f.posts).toEqual(f.mutations);
      expect(f.registry.get("dev")).toMatchObject({
        containerRef: f.container,
        ownerId: 42,
        credentialRef: "file:telegram-saved",
      });
      expect(f.registry.getProvisioning("dev")?.networkRef).toBe(f.network);
      expect(f.registry.getHostCredentialRef("dev")).toBe("file:host-saved");
      expect(f.registry.getRecovery("dev")?.status).toBe("restored");
      expect(f.objects.get(f.containerPath)).toMatchObject({
        State: { Running: false },
      });
    } finally {
      f.close();
    }
  },
);

it.each(["missing volume", "foreign labels", "container name"])(
  "leaves Docker and the registry intact with a %s conflict",
  async (problem) => {
    const f = fixture();
    try {
      const volume = f.names.volumes[2];
      if (problem === "missing volume") f.objects.delete(`/volumes/${volume}`);
      if (problem === "foreign labels")
        f.objects.set(`/volumes/${volume}`, {
          Name: volume,
          Driver: "local",
          Labels: { ...f.labels, "io.nimbot.installation": "other" },
        });
      if (problem === "container name")
        f.objects.set(f.containerPath, { Config: { Labels: f.labels } });
      const before = [...f.objects];
      await expect(f.service().recover("dev")).rejects.toThrow(
        /Restore volume|different agent or installation labels|already exists/,
      );
      expect(f.posts).toEqual([]);
      expect([...f.objects]).toEqual(before);
      expect(f.registry.getRecovery("dev")).toBeUndefined();
    } finally {
      f.close();
    }
  },
);

it("serializes concurrent recovery and lifecycle operations before a Docker mutation completes", async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.onPost(async () => {
    entered();
    await gate;
  });
  const first = f.service().recover("dev");
  try {
    await started;
    await expect(f.service().recover("dev")).rejects.toThrow(
      "already in progress",
    );
    expect(() => f.registry.beginContainerAction("dev", "start")).toThrow();
    expect(() => f.registry.beginResourceRemoval("dev")).toThrow();
  } finally {
    release();
    try {
      await first;
    } finally {
      f.close();
    }
  }
  expect(f.posts).toEqual(f.mutations);
});
