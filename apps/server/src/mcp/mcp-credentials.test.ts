import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openMcpCatalog } from "./mcp-catalog.js";
import { openMcpCredentials } from "./mcp-credentials.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-mcp-credentials-"));
  const state = join(dir, "server.sqlite");
  const directory = join(dir, "mcp-secrets");
  const catalog = openMcpCatalog(state, (id) => ["a", "b"].includes(id));
  const secrets = await openMcpCredentials(catalog, directory);
  const settings = {
    label: "Docs",
    endpoint: "https://docs.example.test/mcp",
    enabled: true,
    tools: [],
  };
  const saved = catalog.create(settings);
  const other = catalog.create({ ...settings, label: "Other" });
  catalog.grant("a", saved.id, 1);
  catalog.grant("b", saved.id, 1);
  catalog.grant("a", other.id, 1);
  return {
    state,
    directory,
    catalog,
    secrets,
    settings,
    saved,
    other,
    async close() {
      catalog.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

it("stores private credential files per agent and integration and replaces or removes exactly one", async () => {
  const f = await fixture();
  const { id } = f.saved;
  try {
    expect(await f.secrets.set("a", id, 1, "example-agent-a")).toEqual({
      hasCredential: true,
      cleanupPending: false,
    });
    expect(await f.secrets.read("b", id, 1)).toBeUndefined();
    expect(await f.secrets.read("a", f.other.id, 1)).toBeUndefined();
    expect(await f.secrets.set("b", id, 1, "example-agent-b")).toMatchObject({
      hasCredential: true,
    });
    expect(
      await f.secrets.set("a", f.other.id, 1, "example-other-integration"),
    ).toMatchObject({ hasCredential: true });
    const firstRef = f.catalog.credentialBinding("a", id)!.reference!;
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(f.directory, firstRef))).mode & 0o777).toBe(0o600);
    expect(
      (await readFile(f.state)).includes(Buffer.from("example-agent-a")),
    ).toBe(false);
    expect(JSON.stringify(f.catalog.list())).not.toContain(firstRef);
    await f.secrets.set("a", id, 1, "example-replacement");
    expect(await f.secrets.read("a", id, 1)).toBe("example-replacement");
    expect(await readdir(f.directory)).not.toContain(firstRef);
    expect(await f.secrets.set("a", id, 1, null)).toEqual({
      hasCredential: false,
      cleanupPending: false,
    });
    expect(f.secrets.has("a", id)).toBe(false);
    expect(await f.secrets.read("a", id, 1)).toBeUndefined();
    expect(await f.secrets.read("b", id, 1)).toBe("example-agent-b");
    expect(await f.secrets.read("a", f.other.id, 1)).toBe(
      "example-other-integration",
    );
  } finally {
    await f.close();
  }
});

it("invalidates old credentials and in-flight replacements when the endpoint changes", async () => {
  const f = await fixture();
  const { id } = f.saved;
  try {
    await f.secrets.set("a", id, 1, "example-old");
    const writing = f.secrets.set("a", id, 1, "example-stale");
    const replacement = f.catalog.update(id, 1, {
      ...f.settings,
      endpoint: "https://new.example.test/mcp",
    })!;
    f.catalog.grant("a", id, replacement.revision);
    expect(await writing).toBeUndefined();
    expect(f.secrets.has("a", id)).toBe(false);
    expect(await f.secrets.read("a", id, replacement.revision)).toBeUndefined();
    expect(await f.secrets.cleanup()).toEqual({ cleanupPending: false });
    expect(await readdir(f.directory)).toEqual([]);
  } finally {
    await f.close();
  }
});

it("retires credentials on agent removal and rejects malformed, stale, and ungranted writes", async () => {
  const f = await fixture();
  try {
    const { id } = f.saved;
    await expect(f.secrets.set("a", id, 1, "bad\r\nheader")).rejects.toThrow(
      "Invalid MCP bearer credential.",
    );
    expect(await f.secrets.set("a", id, 2, "example-stale")).toBeUndefined();
    expect(
      await f.secrets.set("b", f.other.id, 1, "example-ungranted"),
    ).toBeUndefined();
    await f.secrets.set("a", id, 1, "example-agent-a");
    f.catalog.revokeAgent("a");
    expect(await f.secrets.read("a", id, 1)).toBeUndefined();
    expect(await f.secrets.cleanup()).toEqual({ cleanupPending: false });
    expect(await readdir(f.directory)).toEqual([]);
  } finally {
    await f.close();
  }
});

it("keeps failed file deletion durable for retry after a restart", async () => {
  const f = await fixture();
  try {
    const { id } = f.saved;
    await f.secrets.set("a", id, 1, "example-agent-a");
    const ref = f.catalog.credentialBinding("a", id)!.reference!;
    const path = join(f.directory, ref);
    await unlink(path);
    await mkdir(path);
    expect(f.catalog.revoke("a", id)).toBe(true);
    expect(await f.secrets.cleanup()).toEqual({ cleanupPending: true });
    const reopened = openMcpCatalog(f.state, () => true);
    try {
      expect(reopened.retiredCredentials()).toEqual([ref]);
      await rm(path, { recursive: true });
      const secrets = await openMcpCredentials(reopened, f.directory);
      expect(await secrets.cleanup()).toEqual({ cleanupPending: false });
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});
