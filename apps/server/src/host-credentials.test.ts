import { mkdtemp, rm, stat, readdir, chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { openHostCredentials } from "./host-credentials.js";

it("generates distinct private credentials and reuses them after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-host-credentials-"));
  const dbPath = join(dir, "server.sqlite");
  let registry = openAgentRegistry(dbPath);
  try {
    const secrets = join(dir, "host-secrets");
    const store = await openHostCredentials(secrets, registry);
    for (const id of ["a", "b"]) {
      registry.createPending({ id, name: id, ownerId: 42 });
      registry.beginProvisioning(id);
    }
    const a = await store.prepare("a");
    const b = await store.prepare("b");
    expect(a.token).toMatch(/^[a-f0-9]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.url).toBe("http://nimbot-a:3001");
    const ref = registry.getHostCredentialRef("a")!;
    expect(ref).not.toContain(a.token);
    expect((await stat(secrets)).mode & 0o777).toBe(0o700);
    expect((await stat(join(secrets, ref.slice(5)))).mode & 0o777).toBe(0o600);
    registry.close();
    registry = openAgentRegistry(dbPath);
    expect(registry.getProvisioning("a")?.status).toBe("interrupted");
    const restored = await openHostCredentials(secrets, registry);
    expect(await restored.read("a")).toEqual(a);
    registry.beginProvisioning("a");
    expect(await restored.prepare("a")).toEqual(a);
    await unlink(join(secrets, ref.slice(5)));
    await expect(restored.prepare("a")).rejects.toThrow();
    expect(registry.getHostCredentialRef("a")).toBe(ref);
  } finally {
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("cleans candidate files after registry failure and rejects public directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-host-credentials-"));
  try {
    const store = await openHostCredentials(dir, {
      getHostCredentialRef: () => undefined,
      getProvisioning: () => ({
        status: "provisioning",
        volumeRef: null,
        networkRef: null,
        updatedAt: 0,
      }),
      setHostCredentialRef: () => {
        throw new Error("Disk failure");
      },
    });
    await expect(store.prepare("dev")).rejects.toThrow("Disk failure");
    expect(await readdir(dir)).toEqual([]);
    await chmod(dir, 0o755);
    await expect(openHostCredentials(dir, {} as never)).rejects.toThrow(
      "must be private",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("refuses out-of-workflow generation, unsafe IDs, and permissive saved files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-host-credentials-"));
  const registry = openAgentRegistry(":memory:");
  try {
    const store = await openHostCredentials(dir, registry);
    registry.createPending({ id: "dev", name: "Dev", ownerId: 42 });
    await expect(store.prepare("dev")).rejects.toThrow("not provisioning");
    await expect(store.prepare("../escape")).rejects.toThrow(
      "Invalid agent ID",
    );
    expect(await readdir(dir)).toEqual([]);
    registry.beginProvisioning("dev");
    await store.prepare("dev");
    await chmod(
      join(dir, registry.getHostCredentialRef("dev")!.slice(5)),
      0o644,
    );
    await expect(store.read("dev")).rejects.toThrow("must be private");
  } finally {
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});
