import { createResourceReconciliation } from "./resource-reconciliation.js";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { expect, it } from "vitest";
import { createContainerResources } from "./container-resources.js";
import { createContainerControl } from "./container-control.js";
import { createDockerApi } from "./docker-api.js";

// Explicit opt-in: this test creates and removes only uniquely named test resources.
const image = process.env.NIMBOT_TEST_DOCKER_IMAGE;
it.skipIf(!image)(
  "runs the fixed Agent Host template and retains workspace data across recreation",
  async () => {
    const socketPath =
      process.env.NIMBOT_TEST_DOCKER_SOCKET ?? "/var/run/docker.sock";
    const agentId = `test-${randomBytes(8).toString("hex")}`;
    const token = randomBytes(32).toString("hex");
    const installationId = randomBytes(16).toString("hex");
    const call = createDockerApi(socketPath);
    const serverAgentId = `${agentId}-server`;
    const serverResources = createContainerResources({
      socketPath,
      image: image!,
    });
    const serverControl = createContainerControl({
      socketPath,
      agentId: serverAgentId,
      target: `nimbot-${serverAgentId}`,
    });
    const resources = createContainerResources({
      socketPath,
      image: image!,
      installationId,
      serverContainerRef: `nimbot-${serverAgentId}`,
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
    try {
      const server = await serverResources.create(
        serverAgentId,
        randomBytes(32).toString("hex"),
        () => {},
      );
      await serverControl.action("start");
      for (const lifecycle of ["initial", "retained", "purged"]) {
        const refs = await resources.create(agentId, token, () => {});
        const reconcile = createResourceReconciliation(
          {
            listResourceReferences: () => [
              { id: agentId, ...refs },
              { id: serverAgentId, ...server },
            ],
          },
          socketPath,
        );
        const inventory = await reconcile();
        expect(inventory.status).toBe("ok");
        if (inventory.status === "ok") {
          expect(inventory.missing).toEqual([]);
          expect(
            inventory.untracked.filter(
              (r) => r.agentId === agentId || r.agentId === serverAgentId,
            ),
          ).toEqual([]);
        }
        expect(await control.status()).toBe("stopped");
        await control.action("start");
        expect(await control.status()).toBe("running");
        const inspection = JSON.parse(
          (await call(`/containers/${refs.containerRef}/json`)).body,
        );
        expect(inspection.Config.Labels["io.nimbot.installation"]).toBe(
          installationId,
        );
        for (const path of [
          `/networks/${refs.networkRef}`,
          ...["workspace", "engine", "tasks"].map(
            (suffix) => `/volumes/nimbot-${agentId}-${suffix}`,
          ),
        ]) {
          const resource = JSON.parse((await call(path)).body);
          expect(resource.Labels["io.nimbot.installation"]).toBe(
            installationId,
          );
        }
        expect(inspection.Config.User).toBe("1000:1000");
        expect(inspection.HostConfig.CapDrop).toEqual(["ALL"]);
        expect(inspection.HostConfig.SecurityOpt).toContain(
          "no-new-privileges:true",
        );
        expect(inspection.HostConfig.MemorySwap).toBe(
          inspection.HostConfig.Memory,
        );
        expect(inspection.HostConfig.Memory).toBe(1_073_741_824);
        expect(inspection.HostConfig.NanoCpus).toBe(1_000_000_000);
        expect(inspection.HostConfig.PidsLimit).toBe(256);
        expect(inspection.HostConfig.Privileged).toBe(false);
        expect(inspection.HostConfig.CapAdd ?? []).toEqual([]);
        expect(inspection.HostConfig.Binds ?? []).toEqual([]);
        expect(inspection.HostConfig.Devices ?? []).toEqual([]);
        expect(
          inspection.Mounts.map(
            (m: { Destination: string }) => m.Destination,
          ).sort(),
        ).toEqual(
          [
            "/workspace",
            "/home/node/.local/share/opencode",
            "/home/node/.local/share/nimbot",
          ].sort(),
        );
        expect(
          inspection.Mounts.every((m: { Type: string }) => m.Type === "volume"),
        ).toBe(true);
        expect(Object.keys(inspection.NetworkSettings.Networks)).toHaveLength(
          1,
        );
        expect(
          Object.values(inspection.NetworkSettings.Ports ?? {}).every(
            (p) => p === null,
          ),
        ).toBe(true);
        const health = `const r = await fetch('http://localhost:3001/health', {headers: {authorization: 'Bearer ' + process.env.AGENT_HOST_TOKEN}}); if (!r.ok) process.exit(1); console.log(await r.text());`;
        let ready = false;
        let lastError: unknown;
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            expect(JSON.parse(exec(refs.containerRef, health)).workspace).toBe(
              "writable",
            );
            ready = true;
            break;
          } catch (error) {
            lastError = error;
            await setTimeout(200);
          }
        }
        if (!ready) throw lastError;
        // Check kernel-enforced state inside the running container, not only Docker's spec.
        const security = JSON.parse(
          exec(
            refs.containerRef,
            `
          import {readFileSync, existsSync} from 'node:fs';
          const read = (p) => readFileSync(p, 'utf8').trim();
          const status = Object.fromEntries(read('/proc/1/status').split('\\n').map(line => { const i = line.indexOf(':'); return [line.slice(0, i), line.slice(i + 1).trim()]; }));
          const v2 = existsSync('/sys/fs/cgroup/cgroup.controllers');
          const cpu = v2 ? read('/sys/fs/cgroup/cpu.max').split(/\\s+/).map(Number) : [Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')), Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'))];
          const memory = Number(read(v2 ? '/sys/fs/cgroup/memory.max' : '/sys/fs/cgroup/memory/memory.limit_in_bytes'));
          const swap = v2 ? Number(read('/sys/fs/cgroup/memory.swap.max')) : Number(read('/sys/fs/cgroup/memory/memory.memsw.limit_in_bytes')) - memory;
          const pids = Number(read(v2 ? '/sys/fs/cgroup/pids.max' : '/sys/fs/cgroup/pids/pids.max'));
          console.log(JSON.stringify({ uid: process.getuid(), status, cpu: cpu[0] / cpu[1], memory, swap, pids,
            sockets: ['/var/run/docker.sock', '/run/docker.sock'].filter(existsSync),
            serverKeys: Object.keys(process.env).filter(k => /^(TELEGRAM_|PANEL_|DOCKER_|SERVER_)/.test(k)) }));
        `,
          ),
        );
        expect(security.uid).toBe(1000);
        expect(security.status.Uid.split(/\s+/)).toEqual([
          "1000",
          "1000",
          "1000",
          "1000",
        ]);
        for (const capability of [
          "CapInh",
          "CapPrm",
          "CapEff",
          "CapBnd",
          "CapAmb",
        ])
          expect(BigInt(`0x${security.status[capability]}`)).toBe(0n);
        expect(security.status.NoNewPrivs).toBe("1");
        expect(security.cpu).toBe(1);
        expect(security.memory).toBe(1_073_741_824);
        expect(security.swap).toBe(0);
        expect(security.pids).toBe(256);
        expect(security.sockets).toEqual([]);
        expect(security.serverKeys).toEqual([]);
        // This separate container stands in for the Server: only Docker networking
        // connects it to the new Agent Host, with no published host port.
        expect(
          exec(
            server.containerRef,
            `const r = await fetch('http://nimbot-${agentId}:3001/health', {headers: {authorization: 'Bearer ${token}'}}); console.log(r.status);`,
          ),
        ).toBe("200");
        const network = JSON.parse(
          (await call(`/networks/${refs.networkRef}`)).body,
        );
        expect(Object.keys(network.Containers).sort()).toEqual(
          [server.containerRef, refs.containerRef].sort(),
        );
        expect(
          exec(
            refs.containerRef,
            `console.log((await fetch('http://localhost:3001/health')).status)`,
          ),
        ).toBe("401");
        const memories = () =>
          JSON.parse(
            exec(
              refs.containerRef,
              `const r = await fetch('http://localhost:3001/memories', {headers: {authorization: 'Bearer ' + process.env.AGENT_HOST_TOKEN}}); if (!r.ok) throw new Error('Memory inspection failed'); console.log(await r.text());`,
            ),
          ).memories;
        if (lifecycle === "retained") {
          expect(
            exec(
              refs.containerRef,
              `import {readFileSync} from 'node:fs'; console.log(readFileSync('/workspace/retained.txt', 'utf8'));`,
            ),
          ).toBe(agentId);
          expect(memories()).toEqual([
            expect.objectContaining({
              title: "Volume fixture",
              content: agentId,
            }),
          ]);
        } else if (lifecycle === "initial") {
          expect(memories()).toEqual([]);
          exec(
            refs.containerRef,
            `import {writeFileSync} from 'node:fs'; writeFileSync('/workspace/retained.txt', '${agentId}');`,
          );
          exec(
            refs.containerRef,
            `import {openMemoryStore} from '/app/apps/agent-host/dist/memory-store.js'; const store = openMemoryStore('/home/node/.local/share/nimbot/memory.sqlite'); store.create({title: 'Volume fixture', content: '${agentId}'}, '${agentId}'); store.close();`,
          );
          expect(memories()).toHaveLength(1);
        } else {
          expect(memories()).toEqual([]);
          expect(
            exec(
              refs.containerRef,
              `import {existsSync} from 'node:fs'; console.log(existsSync('/workspace/retained.txt'));`,
            ),
          ).toBe("false");
        }
        await control.action("stop");
        expect(await control.status()).toBe("stopped");
        const purge = lifecycle === "retained";
        await resources.remove(agentId, purge);
        expect(await control.status()).toBe("missing");
        for (const suffix of ["workspace", "engine", "tasks"])
          expect(
            (await call(`/volumes/nimbot-${agentId}-${suffix}`)).code,
          ).toBe(purge ? 404 : 200);
      }
    } finally {
      if ((await control.status()) === "running") await control.action("stop");
      try {
        await resources.remove(agentId, true);
      } finally {
        if ((await serverControl.status()) === "running")
          await serverControl.action("stop");
        await serverResources.remove(serverAgentId, true);
      }
    }
    for (const suffix of ["workspace", "engine", "tasks"])
      expect((await call(`/volumes/nimbot-${agentId}-${suffix}`)).code).toBe(
        404,
      );
    expect((await call(`/networks/nimbot-${agentId}-network`)).code).toBe(404);
  },
  90000,
);
