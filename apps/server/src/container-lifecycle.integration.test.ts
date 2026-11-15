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
    const call = createDockerApi(socketPath);
    const resources = createContainerResources({ socketPath, image: image! });
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
      for (const recreate of [false, true]) {
        const refs = await resources.create(agentId, token, () => {});
        expect(await control.status()).toBe("stopped");
        await control.action("start");
        expect(await control.status()).toBe("running");
        const inspection = JSON.parse(
          (await call(`/containers/${refs.containerRef}/json`)).body,
        );
        expect(inspection.Config.User).toBe("1000:1000");
        expect(inspection.HostConfig.CapDrop).toEqual(["ALL"]);
        expect(inspection.HostConfig.SecurityOpt).toContain(
          "no-new-privileges:true",
        );
        expect(inspection.HostConfig.MemorySwap).toBe(
          inspection.HostConfig.Memory,
        );
        expect(inspection.HostConfig.NanoCpus).toBe(1_000_000_000);
        expect(inspection.HostConfig.PidsLimit).toBe(256);
        expect(inspection.HostConfig.Privileged).toBe(false);
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
        expect(
          exec(
            refs.containerRef,
            `console.log((await fetch('http://localhost:3001/health')).status)`,
          ),
        ).toBe("401");
        if (recreate) {
          expect(
            exec(
              refs.containerRef,
              `import {readFileSync} from 'node:fs'; console.log(readFileSync('/workspace/retained.txt', 'utf8'));`,
            ),
          ).toBe(agentId);
        } else {
          exec(
            refs.containerRef,
            `import {writeFileSync} from 'node:fs'; writeFileSync('/workspace/retained.txt', '${agentId}');`,
          );
        }
        await control.action("stop");
        expect(await control.status()).toBe("stopped");
        await resources.remove(agentId);
        expect(await control.status()).toBe("missing");
        expect((await call(`/volumes/${refs.volumeRef}`)).code).toBe(200);
      }
    } finally {
      if ((await control.status()) === "running") await control.action("stop");
      await resources.remove(agentId, true);
    }
    for (const suffix of ["workspace", "engine", "tasks"])
      expect((await call(`/volumes/nimbot-${agentId}-${suffix}`)).code).toBe(
        404,
      );
    expect((await call(`/networks/nimbot-${agentId}-network`)).code).toBe(404);
  },
  90000,
);
