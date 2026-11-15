import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { expect, it } from "vitest";
import { createContainerResources } from "./container-resources.js";
import { createContainerControl } from "./container-control.js";
import { createDockerApi } from "./docker-api.js";

// Explicit opt-in: creates and removes only uniquely named test resources.
const image = process.env.NIMBOT_TEST_DOCKER_IMAGE;
it.skipIf(!image)(
  "keeps an Agent Host's limits, capabilities, and network after a server restart and a Host restart",
  async () => {
    const socketPath =
      process.env.NIMBOT_TEST_DOCKER_SOCKET ?? "/var/run/docker.sock";
    const agentId = `test-${randomBytes(8).toString("hex")}`;
    const serverId = `${agentId}-server`;
    const token = randomBytes(32).toString("hex");
    const call = createDockerApi(socketPath);
    const serverResources = createContainerResources({
      socketPath,
      image: image!,
    });
    const serverControl = createContainerControl({
      socketPath,
      agentId: serverId,
      target: `nimbot-${serverId}`,
    });
    const resources = createContainerResources({
      socketPath,
      image: image!,
      serverContainerRef: `nimbot-${serverId}`,
    });
    const control = createContainerControl({
      socketPath,
      agentId,
      target: `nimbot-${agentId}`,
    });
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
    const probe = async (server: string) => {
      const script = `try { const r = await fetch('http://nimbot-${agentId}:3001/health', {headers: {authorization: 'Bearer ${token}'}, signal: AbortSignal.timeout(1500)}); console.log(r.status); } catch { console.log('unreachable'); }`;
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = exec(server, script);
        if (result === "200") return result;
        await setTimeout(300);
      }
      return exec(server, script);
    };
    /** Everything the template promises, read from Docker and from the running kernel. */
    const hardening = async (id: string) => {
      const inspection = JSON.parse(
        (await call(`/containers/${id}/json`)).body,
      );
      const kernel = JSON.parse(
        exec(
          id,
          `import {readFileSync} from 'node:fs';
          const s = Object.fromEntries(readFileSync('/proc/1/status','utf8').trim().split('\\n').map(l => { const i = l.indexOf(':'); return [l.slice(0,i), l.slice(i+1).trim()]; }));
          console.log(JSON.stringify({ uid: process.getuid(), caps: ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(k => s[k]), noNewPrivs: s.NoNewPrivs }));`,
        ),
      );
      return {
        user: inspection.Config.User,
        capDrop: inspection.HostConfig.CapDrop,
        capAdd: inspection.HostConfig.CapAdd ?? [],
        securityOpt: inspection.HostConfig.SecurityOpt,
        memory: inspection.HostConfig.Memory,
        memorySwap: inspection.HostConfig.MemorySwap,
        cpus: inspection.HostConfig.NanoCpus,
        pids: inspection.HostConfig.PidsLimit,
        privileged: inspection.HostConfig.Privileged,
        binds: inspection.HostConfig.Binds ?? [],
        networks: Object.keys(inspection.NetworkSettings.Networks),
        published: Object.values(inspection.NetworkSettings.Ports ?? {}).filter(
          (p) => p !== null,
        ),
        kernel,
      };
    };
    try {
      const server = await serverResources.create(
        serverId,
        randomBytes(32).toString("hex"),
        () => {},
      );
      await serverControl.action("start");
      const refs = await resources.create(agentId, token, () => {});
      await control.action("start");
      expect(await probe(server.containerRef)).toBe("200");
      const before = await hardening(refs.containerRef);
      expect(before).toMatchObject({
        user: "1000:1000",
        capDrop: ["ALL"],
        capAdd: [],
        privileged: false,
        pids: 256,
        memory: 1_073_741_824,
        memorySwap: 1_073_741_824,
        published: [],
        kernel: {
          uid: 1000,
          caps: [
            "0000000000000000",
            "0000000000000000",
            "0000000000000000",
            "0000000000000000",
            "0000000000000000",
          ],
          noNewPrivs: "1",
        },
      });
      expect(before.networks).toEqual([`nimbot-${agentId}-network`]);

      // Server restart: the server goes away and returns; the Host keeps running untouched.
      await serverControl.action("stop");
      expect(await control.status()).toBe("running");
      await serverControl.action("start");
      expect(await probe(server.containerRef)).toBe("200");
      expect(await hardening(refs.containerRef)).toEqual(before);

      // Host restart (same container): limits and isolation come from the container, not the process.
      await control.action("stop");
      await control.action("start");
      expect(await probe(server.containerRef)).toBe("200");
      expect(await hardening(refs.containerRef)).toEqual(before);
      const network = JSON.parse(
        (await call(`/networks/${refs.networkRef}`)).body,
      );
      expect(Object.keys(network.Containers).sort()).toEqual(
        [server.containerRef, refs.containerRef].sort(),
      );
    } finally {
      if ((await control.status()) === "running") await control.action("stop");
      try {
        await resources.remove(agentId, true);
      } finally {
        if ((await serverControl.status()) === "running")
          await serverControl.action("stop");
        await serverResources.remove(serverId, true);
      }
    }
  },
  120000,
);
