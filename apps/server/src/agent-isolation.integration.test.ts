import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { expect, it } from "vitest";
import { createContainerResources } from "./container-resources.js";
import { createContainerControl } from "./container-control.js";
import { createDockerApi } from "./docker-api.js";
import { openAgentRegistry } from "./agent-registry.js";
import { openHostCredentials } from "./host-credentials.js";

const image = process.env.NIMBOT_TEST_DOCKER_IMAGE;
it.skipIf(!image)(
  "isolates Agent Host networks and credentials while allowing server access",
  async () => {
    const socketPath =
      process.env.NIMBOT_TEST_DOCKER_SOCKET ?? "/var/run/docker.sock";
    const base = `test-${randomBytes(8).toString("hex")}`;
    const dir = await mkdtemp(join(tmpdir(), "nimbot-isolation-"));
    const registry = openAgentRegistry(join(dir, "server.sqlite"));
    const credentials = await openHostCredentials(
      join(dir, "host-secrets"),
      registry,
    );
    const call = createDockerApi(socketPath);
    const exec = (container: string, script: string) =>
      execFileSync(
        "docker",
        [
          "--host",
          `unix://${socketPath}`,
          "exec",
          container,
          "node",
          "--input-type=module",
          "-e",
          script,
        ],
        { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
    const request = (container: string, url: string, token: string) =>
      exec(
        container,
        `try { const r = await fetch('${url}/health', {headers: {authorization: 'Bearer ${token}'}, signal: AbortSignal.timeout(1500)}); console.log(r.status); } catch { console.log('unreachable'); } process.exit(0);`,
      );
    const serverId = `${base}-server`;
    const serverResources = createContainerResources({
      socketPath,
      image: image!,
    });
    const resources = createContainerResources({
      socketPath,
      image: image!,
      serverContainerRef: `nimbot-${serverId}`,
    });
    const control = (id: string) =>
      createContainerControl({
        socketPath,
        agentId: id,
        target: `nimbot-${id}`,
      });
    const agents: {
      id: string;
      token: string;
      url: string;
      container: string;
      network: string;
      ip: string;
    }[] = [];
    const errors: unknown[] = [];
    try {
      const server = await serverResources.create(
        serverId,
        randomBytes(32).toString("hex"),
        () => {},
      );
      await control(serverId).action("start");
      for (const suffix of ["a", "b"]) {
        const id = `${base}-${suffix}`;
        registry.createPending({ id, name: id, ownerId: 42 });
        registry.beginProvisioning(id);
        const host = await credentials.prepare(id);
        const refs = await resources.create(id, host.token, (r) =>
          registry.recordProvisioningResources(id, r),
        );
        await control(id).action("start");
        let ready = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          if (request(server.containerRef, host.url, host.token) === "200") {
            ready = true;
            break;
          }
          await setTimeout(100);
        }
        expect(ready).toBe(true);
        const container = JSON.parse(
          (await call(`/containers/${refs.containerRef}/json`)).body,
        );
        expect(Object.keys(container.NetworkSettings.Networks)).toHaveLength(1);
        expect(
          Object.values(container.NetworkSettings.Ports ?? {}).every(
            (p) => p === null,
          ),
        ).toBe(true);
        expect(container.HostConfig.PublishAllPorts).toBe(false);
        const endpoint = Object.values(
          container.NetworkSettings.Networks,
        )[0] as { IPAddress: string };
        expect(endpoint.IPAddress).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
        const network = JSON.parse(
          (await call(`/networks/${refs.networkRef}`)).body,
        );
        expect(Object.keys(network.Containers).sort()).toEqual(
          [server.containerRef, refs.containerRef].sort(),
        );
        agents.push({
          id,
          token: host.token,
          url: host.url,
          container: refs.containerRef,
          network: refs.networkRef,
          ip: endpoint.IPAddress,
        });
      }
      const a = agents[0]!;
      const b = agents[1]!;
      expect(a.token).not.toBe(b.token);
      expect(a.network).not.toBe(b.network);
      for (const [from, to] of [
        [a, b],
        [b, a],
      ]) {
        // Positive control: the target remains reachable through its own network.
        expect(request(server.containerRef, to!.url, to!.token)).toBe("200");
        expect(request(server.containerRef, to!.url, from!.token)).toBe("401");
        expect(
          request(server.containerRef, `http://${to!.ip}:3001`, to!.token),
        ).toBe("200");
        // Use the correct target credential: these must fail at the network layer.
        expect(request(from!.container, to!.url, to!.token)).toBe(
          "unreachable",
        );
        expect(
          request(from!.container, `http://${to!.ip}:3001`, to!.token),
        ).toBe("unreachable");
      }
    } finally {
      for (const id of [`${base}-a`, `${base}-b`, serverId]) {
        try {
          if ((await control(id).status()) === "running")
            await control(id).action("stop");
          await (id === serverId ? serverResources : resources).remove(
            id,
            true,
          );
        } catch (error) {
          errors.push(error);
        }
      }
      registry.close();
      await rm(dir, { recursive: true, force: true });
    }
    if (errors.length)
      throw new AggregateError(errors, "Isolation test cleanup failed");
  },
  90000,
);
