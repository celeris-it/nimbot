import { mkdtemp, rm, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { openBotSecrets } from "./bot-secret.js";
import { createBotTokenUpdate } from "./bot-token-update.js";
import { openAgentRegistry } from "./agents/agent-registry.js";

it("verifies identity, stores private files and preserves their reference at startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-secrets-"));
  const registry = openAgentRegistry(":memory:");
  try {
    const secrets = await openBotSecrets(join(dir, "secrets"));
    registry.createPending({ id: "dev", name: "Dev", ownerId: 42 });
    registry.bindBot("dev", 123, "dev_bot");
    const verify = vi.fn().mockResolvedValue({ id: 456 });
    const update = createBotTokenUpdate("dev", registry, secrets, verify);
    await expect(update("123:new_token")).rejects.toThrow("another bot");
    expect(await readdir(join(dir, "secrets"))).toEqual([]);
    verify.mockResolvedValue({ id: 123 });
    await update("123:new_token");
    const ref = registry.get("dev")!.credentialRef!;
    expect(ref).not.toContain("new_token");
    expect(await secrets.read(ref)).toBe("123:new_token");
    expect((await stat(join(dir, "secrets"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "secrets", ref.slice(5)))).mode & 0o777).toBe(
      0o600,
    );
    registry.bindBot("dev", 123, "dev_bot");
    expect(registry.get("dev")!.credentialRef).toBe(ref);
    const reopened = await openBotSecrets(join(dir, "secrets"));
    expect(await reopened.read(ref)).toBe("123:new_token");
    vi.spyOn(registry, "setCredentialRef").mockImplementationOnce(() => {
      throw new Error("DB failure");
    });
    await expect(update("123:another_token")).rejects.toThrow("DB failure");
    expect(await readdir(join(dir, "secrets"))).toHaveLength(1);
    await expect(secrets.read("file:../../etc/passwd")).rejects.toThrow(
      "Invalid credential reference",
    );
  } finally {
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});
