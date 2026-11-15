import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { openBotSecrets } from "./bot-secret.js";
import { createAgentRegistration } from "./agent-registration.js";

const input = {
  name: " Developer ",
  instructions: "Be brief",
  ownerId: 42,
  token: "123:test-token",
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-registration-"));
  const registry = openAgentRegistry(join(dir, "server.sqlite"));
  const secrets = await openBotSecrets(join(dir, "secrets"));
  const verify = vi.fn(async () => ({
    id: 123,
    username: "developer_bot",
    is_bot: true,
  }));
  const provision = vi.fn(async (id: string) => {
    const agent = registry.get(id)!;
    expect(agent.botId).toBe(123);
    expect(await secrets.read(agent.credentialRef!)).toBe(input.token);
    expect(registry.getProvisioning(id)?.status).toBe("pending");
  });
  const register = createAgentRegistration(
    registry,
    secrets,
    new Set([42]),
    provision,
    verify,
  );
  return {
    registry,
    secrets,
    verify,
    provision,
    register,
    files: () => readdir(join(dir, "secrets")),
    close: async () => {
      registry.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

it("links verified bot and saved credentials atomically before provisioning", async () => {
  const f = await fixture();
  try {
    const result = await f.register(input);
    expect(result).toEqual({
      agentId: expect.stringMatching(/^agent-[a-f0-9]{32}$/),
      provisioning: "pending",
    });
    expect(f.registry.get(result.agentId)).toMatchObject({
      name: "Developer",
      instructions: input.instructions,
      ownerId: 42,
      botId: 123,
      botUsername: "developer_bot",
      credentialRef: expect.stringMatching(/^file:telegram-/),
    });
    expect(JSON.stringify(result)).not.toContain(input.token);
    expect(f.provision).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("rejects invalid input and unauthorized owners before Telegram, storage, or Docker", async () => {
  const f = await fixture();
  try {
    for (const invalid of [
      { ...input, ownerId: 43 },
      { ...input, name: " " },
      { ...input, instructions: "x".repeat(4001) },
      { ...input, token: "invalid" },
    ])
      await expect(f.register(invalid)).rejects.toThrow();
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.provision).not.toHaveBeenCalled();
    expect(await f.files()).toEqual([]);
    expect(f.registry.listResourceReferences()).toEqual([]);
  } finally {
    await f.close();
  }
});

it("cleans the rejected credential when two requests race to link the same bot", async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled([
      f.register(input),
      f.register(input),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await f.files()).toHaveLength(1);
    expect(f.registry.listResourceReferences()).toHaveLength(1);
    expect(f.provision).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("keeps the linked agent and credential after a provisioning failure", async () => {
  const f = await fixture();
  f.provision.mockImplementation(async (id) => {
    f.registry.beginProvisioning(id);
    f.registry.recordProvisioningResources(id, {
      volumeRef: `nimbot-${id}-workspace`,
    });
    f.registry.finishProvisioning(id, "failed");
    throw new Error("Docker failed");
  });
  try {
    const result = await f.register(input);
    expect(result.provisioning).toBe("failed");
    expect(f.registry.getProvisioning(result.agentId)?.volumeRef).toBeTruthy();
    expect(
      await f.secrets.read(f.registry.get(result.agentId)!.credentialRef!),
    ).toBe(input.token);
  } finally {
    await f.close();
  }
});

it("does not register or save credentials when Telegram verification fails", async () => {
  const f = await fixture();
  f.verify.mockRejectedValue(new Error("Revoked token"));
  try {
    await expect(f.register(input)).rejects.toThrow();
    expect(await f.files()).toEqual([]);
    expect(f.registry.listResourceReferences()).toEqual([]);
    expect(f.provision).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("returns the saved agent while background setup is still active so the panel can cancel it", async () => {
  const { createProvisioningControl } =
    await import("./provisioning-control.js");
  const f = await fixture();
  let release!: () => void;
  const control = createProvisioningControl(f.registry, async (id, signal) => {
    f.registry.beginProvisioning(id);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    f.registry.finishProvisioning(id, signal.aborted ? "cancelled" : "failed");
  });
  f.provision.mockImplementation(async (id) => {
    control.start(id);
  });
  try {
    const result = await f.register(input);
    expect(result.provisioning).toBe("provisioning");
    expect(control.canCancel(result.agentId)).toBe(true);
    expect(
      await f.secrets.read(f.registry.get(result.agentId)!.credentialRef!),
    ).toBe(input.token);
    control.cancel(result.agentId);
    expect(f.registry.getProvisioningCancellation(result.agentId)).toEqual(
      expect.any(Number),
    );
    release();
    await vi.waitFor(() =>
      expect(control.canCancel(result.agentId)).toBe(false),
    );
    expect(f.registry.getProvisioning(result.agentId)?.status).toBe(
      "cancelled",
    );
  } finally {
    await f.close();
  }
});
