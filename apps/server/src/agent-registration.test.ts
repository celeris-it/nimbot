import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { openBotSecrets } from "./bot-secret.js";
import {
  createAgentRegistration,
  createTelegramLink,
} from "./agent-registration.js";

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
    expect(registry.get(id)).toBeDefined();
  });
  let setupStatus: "pending" | "failed" = "pending";
  const register = createAgentRegistration(
    registry,
    secrets,
    provision,
    verify,
    () => setupStatus,
  );
  return {
    registry,
    secrets,
    verify,
    provision,
    register,
    failSetup() {
      setupStatus = "failed";
    },
    files: () => readdir(join(dir, "secrets")),
    close: async () => {
      registry.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

it("links verified bot and saved credentials atomically before Host startup", async () => {
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
    expect(
      await f.secrets.read(f.registry.get(result.agentId)!.credentialRef!),
    ).toBe(input.token);
    expect(f.provision).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("saves an agent before any messaging setup and lets exactly one first Telegram link win", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.register({
      name: "Researcher",
      instructions: "",
    });
    expect(f.registry.get(agentId)).toMatchObject({
      name: "Researcher",
      ownerId: null,
      botId: null,
      credentialRef: null,
    });
    expect(f.provision).toHaveBeenCalledExactlyOnceWith(agentId);
    expect(f.verify).not.toHaveBeenCalled();
    expect(await f.files()).toEqual([]);

    const link = createTelegramLink(f.registry, f.secrets, f.verify);
    await expect(link(agentId, 42, "invalid")).rejects.toThrow(
      "Invalid Telegram",
    );
    const outcomes = await Promise.allSettled([
      link(agentId, 42, input.token),
      link(agentId, 43, input.token),
    ]);
    const winners = outcomes.flatMap((outcome, index) =>
      outcome.status === "fulfilled" ? [42 + index] : [],
    );
    expect(winners).toHaveLength(1);
    expect(f.registry.get(agentId)).toMatchObject({
      ownerId: winners[0],
      botId: 123,
    });
    expect(await f.files()).toHaveLength(1);

    const other = await f.register({ name: "Other", instructions: "" });
    await expect(link(other.agentId, 42, input.token)).rejects.toThrow(
      "already assigned",
    );
    expect(f.registry.get(other.agentId)).toMatchObject({
      ownerId: null,
      botId: null,
    });
    expect(await f.files()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("rejects invalid input and owner IDs before Telegram, storage, or Host startup", async () => {
  const f = await fixture();
  try {
    for (const invalid of [
      { ...input, ownerId: 0 },
      { ...input, ownerId: -5 },
      { ...input, ownerId: 1.5 },
      { ...input, name: " " },
      { ...input, instructions: "x".repeat(4001) },
      { ...input, token: "invalid" },
    ])
      await expect(f.register(invalid)).rejects.toThrow();
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.provision).not.toHaveBeenCalled();
    expect(await f.files()).toEqual([]);
    expect(f.registry.listIds()).toEqual([]);
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
    expect(f.registry.listIds()).toHaveLength(1);
    expect(f.provision).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("keeps the linked agent and credential after a Host startup failure", async () => {
  const f = await fixture();
  f.provision.mockImplementation(async (id) => {
    expect(f.registry.get(id)).toBeDefined();
    f.failSetup();
    throw new Error("Host startup failed");
  });
  try {
    const result = await f.register(input);
    expect(result.provisioning).toBe("failed");
    expect(f.registry.get(result.agentId)).toBeDefined();
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
    expect(f.registry.listIds()).toEqual([]);
    expect(f.provision).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects a bot already bound to another agent without touching the first agent", async () => {
  const f = await fixture();
  try {
    const first = await f.register(input);
    await expect(
      f.register({ ...input, name: "Second", token: "123:other-token" }),
    ).rejects.toThrow();
    expect(f.registry.listIds()).toHaveLength(1);
    expect(f.registry.get(first.agentId)).toMatchObject({
      name: "Developer",
      botId: 123,
    });
    expect(await f.files()).toHaveLength(1);
    expect(f.provision).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});
