import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { createDockerApi, type DockerApi } from "./docker-api.js";
import { createAgentProvisioning } from "./agent-provisioning.js";
import { createAgentResourceRemoval } from "./agent-resource-removal.js";
import { createContainerResources } from "./container-resources.js";
import { createResourceReconciliation } from "./resource-reconciliation.js";

const image = process.env.NIMBOT_TEST_DOCKER_IMAGE;
// Opt-in: only uniquely named, stopped test resources are created and removed.
it.skipIf(!image)(
  "tracks a real Docker container when its creation reply is lost and retains volumes during explicit cleanup",
  async () => {
    const id = `test-${randomBytes(8).toString("hex")}`;
    const dir = await mkdtemp(join(tmpdir(), "nimbot-docker-intent-"));
    const path = join(dir, "state.sqlite");
    let registry = openAgentRegistry(path);
    const config = {
      socketPath:
        process.env.NIMBOT_TEST_DOCKER_SOCKET ?? "/var/run/docker.sock",
      image: image!,
    };
    const call = createDockerApi(config.socketPath);
    const uncertainCall: DockerApi = async (url, method, body) => {
      const response = await call(url, method, body);
      if (url.startsWith("/containers/create?") && response.code === 201)
        throw new Error("Simulated lost Docker reply");
      return response;
    };
    const health = vi.fn<typeof fetch>();
    try {
      registry.createPending({
        id,
        name: "Uncertain creation test",
        ownerId: 42,
      });
      registry.bindBot(id, 123, "intent_test_bot");
      const provision = createAgentProvisioning(
        registry,
        {
          prepare: async () => {
            registry.setHostCredentialRef(id, "file:host-test");
            return {
              url: `http://nimbot-${id}:3001`,
              token: randomBytes(32).toString("hex"),
            };
          },
        },
        config,
        uncertainCall,
        health,
      );
      await expect(provision(id)).rejects.toThrow("Agent provisioning failed");
      expect(health).not.toHaveBeenCalled();
      expect(registry.get(id)?.containerRef).toBeNull();
      const intents = registry.listProvisioningIntents();
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({
        agentId: id,
        kind: "container",
        name: `nimbot-${id}`,
      });
      registry.close();
      registry = openAgentRegistry(path);
      expect(registry.getProvisioning(id)?.status).toBe("failed");
      expect(registry.listProvisioningIntents()).toEqual(intents);
      const reconcile = () =>
        createResourceReconciliation(registry, config.socketPath, call)();
      const inventory = await reconcile();
      expect(inventory.status).toBe("ok");
      if (inventory.status !== "ok")
        throw new Error("Docker inventory unavailable");
      expect(inventory.uncertain).toEqual(intents);
      expect(inventory.untracked.filter((r) => r.agentId === id)).toEqual([]);
      const inspection = await call(`/containers/nimbot-${id}/json`);
      expect(inspection.code).toBe(200);
      const container = JSON.parse(inspection.body);
      expect(container.State.Running).toBe(false);
      expect(container.Config.Labels["io.nimbot.provisioning-operation"]).toBe(
        intents[0]!.operationId,
      );
      const remove = createAgentResourceRemoval(registry, config, call);
      await remove(id, false);
      expect(registry.listProvisioningIntents()).toEqual([]);
      expect((await call(`/containers/nimbot-${id}/json`)).code).toBe(404);
      expect((await call(`/volumes/nimbot-${id}-workspace`)).code).toBe(200);
      await remove(id, true);
      expect((await call(`/volumes/nimbot-${id}-workspace`)).code).toBe(404);
    } finally {
      try {
        await createContainerResources(config, call).remove(id, true);
      } finally {
        registry.close();
        await rm(dir, { recursive: true, force: true });
      }
    }
  },
  60000,
);
