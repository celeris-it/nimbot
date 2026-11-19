import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentContainerAction } from "../apps/server/src/agent-container-action.js";
import { createAgentRecovery } from "../apps/server/src/agent-recovery.js";
import { openAgentRegistry } from "../apps/server/src/agent-registry.js";
import { openChatBinding } from "../apps/server/src/chat-binding.js";
import { createContainerControl } from "../apps/server/src/container-control.js";
import {
  agentResourceNames,
  createContainerResources,
} from "../apps/server/src/container-resources.js";
import { openHostCredentials } from "../apps/server/src/host-credentials.js";
import { createRecoveryWorkGate } from "../apps/server/src/recovery-work-gate.js";
import { openTaskStore } from "../apps/server/src/task-queue.js";
import { restoreAgentVolumes } from "../scripts/restore-agent-volumes.mjs";

const image = process.env.NIMBOT_TEST_DOCKER_IMAGE;
it.runIf(image)(
  "recovers a backed-up agent and resumes its saved queue after an authenticated Start",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "nimbot-recovery-docker-"));
    const socketPath =
      process.env.NIMBOT_TEST_DOCKER_SOCKET ?? "/var/run/docker.sock";
    const installationId = randomUUID().replaceAll("-", "");
    const agentId = `restore-${installationId.slice(0, 12)}`;
    const names = agentResourceNames(agentId);
    const serverContainerRef = `${names.container}-server`;
    const config = {
      image: image!,
      socketPath,
      installationId,
      serverContainerRef,
    };
    const resources = createContainerResources(config);
    const namedControl = createContainerControl({
      socketPath,
      target: names.container,
      agentId,
    });
    const docker = (...args: string[]) =>
      execFileSync("docker", ["--host", `unix://${socketPath}`, ...args], {
        encoding: "utf8",
        timeout: 15000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const source = join(directory, "source");
    const backup = join(directory, "backup");
    const restored = join(directory, "restored");
    try {
      await mkdir(source);
      await mkdir(backup);
      docker(
        "run",
        "-d",
        "--name",
        serverContainerRef,
        "--label",
        `io.nimbot.installation=${installationId}`,
        "node:22-bookworm-slim",
        "sleep",
        "120",
      );
      const { original, queued, targets } = await saveSource();
      await resources.remove(agentId, true);
      expect(await namedControl.status()).toBe("missing");
      restoreAgentVolumes(
        backup,
        agentId,
        installationId,
        (command: string, args: string[]) =>
          command === "docker"
            ? docker(...args)
            : (execFileSync(command, args, {
                encoding: "utf8",
                stdio: ["ignore", "ignore", "pipe"],
              }) ?? ""),
      );

      await cp(join(backup, "server"), restored, { recursive: true });
      const state = join(restored, "server.sqlite");
      const registry = openAgentRegistry(state);
      const tasks = openTaskStore(state);
      try {
        const credentials = await openHostCredentials(
          join(restored, "host-secrets"),
          registry,
        );
        const recovery = createAgentRecovery(registry, credentials, config);
        const control = () =>
          createContainerControl({
            socketPath,
            target: registry.get(agentId)!.containerRef!,
            agentId,
          });
        const host = await credentials.read(agentId);
        const gate = createRecoveryWorkGate(
          registry,
          () => control().status(),
          async () => {
            try {
              const status = docker(
                "exec",
                serverContainerRef,
                "node",
                "-e",
                "fetch(process.argv[1] + '/health', {headers: {Authorization: 'Bearer ' + process.argv[2]}, signal: AbortSignal.timeout(2000)}).then(async (r) => console.log(r.ok && (await r.json()).workspace === 'writable' ? 'ready' : 'unavailable')).catch(() => console.log('unavailable'))",
                host.url,
                host.token,
              );
              return status === "ready" ? "ready" : "unavailable";
            } catch {
              return "unavailable";
            }
          },
        );
        await gate.check(agentId);
        const claim = () =>
          tasks.claimNextTask(agentId, () => gate.allowsWork(agentId));
        expect(claim()).toBeUndefined();
        expect(await recovery.inspect(agentId)).toEqual({
          status: "available",
        });
        await recovery.recover(agentId);
        const container = registry.get(agentId)!.containerRef!;
        expect(container).not.toBe(original.containerRef);
        expect(registry.getProvisioning(agentId)?.networkRef).not.toBe(
          original.networkRef,
        );
        expect(registry.get(agentId)?.ownerId).toBe(42);
        expect(registry.getOwnerChat(agentId)).toBe(42);
        expect(await control().status()).toBe("stopped");
        expect(claim()).toBeUndefined();
        expect(tasks.getTask(queued.id)?.status).toBe("queued");

        await createAgentContainerAction(registry, socketPath)(
          agentId,
          "start",
        );
        await expect
          .poll(
            async () => {
              await gate.check(agentId);
              return gate.allowsWork(agentId);
            },
            { timeout: 12000 },
          )
          .toBe(true);
        expect(claim()).toMatchObject({ id: queued.id, prompt: "Saved task" });
        for (const [index, target] of targets.entries())
          expect(
            docker("exec", container, "cat", `${target}/recovery-marker`),
          ).toBe(`saved-${index}`);
      } finally {
        tasks.close();
        registry.close();
      }
    } finally {
      try {
        if ((await namedControl.status()) === "running")
          await namedControl.action("stop");
        await resources.remove(agentId, true);
      } finally {
        try {
          docker("rm", "-f", serverContainerRef);
        } catch {
          /* Setup may have failed. */
        }
        await rm(directory, { force: true, recursive: true });
      }
    }

    async function saveSource() {
      const state = join(source, "server.sqlite");
      const registry = openAgentRegistry(state);
      const tasks = openTaskStore(state);
      const binding = openChatBinding(state, { id: agentId, ownerId: 42 });
      const targets = [
        "/workspace",
        "/home/node/.local/share/opencode",
        "/home/node/.local/share/nimbot",
      ];
      try {
        registry.createPending({
          id: agentId,
          name: "Restore fixture",
          ownerId: 42,
        });
        registry.bindBot(agentId, 7, "restore_bot");
        registry.setCredentialRef(agentId, `file:telegram-${randomUUID()}`);
        registry.beginProvisioning(agentId);
        const credentials = await openHostCredentials(
          join(source, "host-secrets"),
          registry,
        );
        const host = await credentials.prepare(agentId);
        const original = await resources.create(agentId, host.token, (refs) =>
          registry.recordProvisioningResources(agentId, refs),
        );
        registry.finishProvisioning(agentId, "ready");
        binding.save(7, 42);
        const queued = tasks.enqueue({
          agentId,
          botId: 7,
          chatId: 42,
          prompt: "Saved task",
        });
        for (const [index, name] of names.volumes.entries()) {
          docker(
            "run",
            "--rm",
            "--network",
            "none",
            "-v",
            `${name}:/data`,
            "-v",
            `${backup}:/backup`,
            "node:22-bookworm-slim",
            "sh",
            "-ec",
            'printf "%s" "$1" > /data/recovery-marker; chown 1000:1000 /data /data/recovery-marker; tar -czf "/backup/$2.tar.gz" -C /data .',
            "sh",
            `saved-${index}`,
            name,
          );
        }
        return { original, queued, targets };
      } finally {
        binding.close();
        tasks.close();
        registry.close();
        await cp(source, join(backup, "server"), { recursive: true });
      }
    }
  },
  120000,
);
