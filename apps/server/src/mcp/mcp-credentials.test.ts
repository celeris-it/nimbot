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

it("stores one private credential per integration and replaces or removes it", async () => {
  const f = await fixture();
  const { id } = f.saved;
  try {
    expect(await f.secrets.set(id, 1, "example-shared-token")).toEqual({
      cleanupPending: false,
    });
    expect(await f.secrets.read(id, 2)).toBe("example-shared-token");
    expect(await f.secrets.read(f.other.id, 1)).toBeUndefined();
    await f.secrets.set(f.other.id, 1, "example-other-token");
    const firstRef = f.catalog.credentialBinding(id)!.reference!;
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(f.directory, firstRef))).mode & 0o777).toBe(0o600);
    expect(
      (await readFile(f.state)).includes(Buffer.from("example-shared-token")),
    ).toBe(false);
    expect(JSON.stringify(f.catalog.list())).not.toContain(firstRef);
    await f.secrets.set(id, 2, "example-replacement");
    expect(await f.secrets.read(id, 2)).toBeUndefined();
    expect(await f.secrets.read(id, 3)).toBe("example-replacement");
    expect(await readdir(f.directory)).not.toContain(firstRef);
    expect(await f.secrets.set(id, 3, null)).toEqual({ cleanupPending: false });
    expect(f.catalog.get(id)!.credentialStatus).toBe("none");
    expect(await f.secrets.read(id, 4)).toBeUndefined();
    expect(await f.secrets.read(f.other.id, 2)).toBe("example-other-token");
  } finally {
    await f.close();
  }
});

it("retires the old credential and rejects in-flight replacements when the endpoint changes", async () => {
  const f = await fixture();
  const { id } = f.saved;
  try {
    await f.secrets.set(id, 1, "example-old");
    const writing = f.secrets.set(id, 2, "example-stale");
    const replacement = f.catalog.update(id, 2, {
      ...f.settings,
      endpoint: "https://new.example.test/mcp",
    })!;
    expect(await writing).toBeUndefined();
    expect(replacement.credentialStatus).toBe("required");
    expect(await f.secrets.read(id, replacement.revision)).toBeUndefined();
    expect(
      [...f.catalog.availableForAgent("a")].map(
        ({ definition }) => definition.id,
      ),
    ).toEqual([f.other.id]);
    expect(await f.secrets.cleanup()).toEqual({ cleanupPending: false });
    expect(await readdir(f.directory)).toEqual([]);
  } finally {
    await f.close();
  }
});

it("keeps the shared credential after agent removal and rejects malformed and stale writes", async () => {
  const f = await fixture();
  try {
    const { id } = f.saved;
    await expect(f.secrets.set(id, 1, "bad\r\nheader")).rejects.toThrow(
      "Invalid MCP bearer credential.",
    );
    expect(await f.secrets.set(id, 2, "example-stale")).toBeUndefined();
    expect(
      await f.secrets.set("missing", 1, "example-unknown"),
    ).toBeUndefined();
    await f.secrets.set(id, 1, "example-shared");
    f.catalog.setAccess("a", id, 2, false);
    f.catalog.removeAgentAccess("a");
    expect(f.catalog.accessScope("a", id)).toBe("default");
    expect(await f.secrets.read(id, 2)).toBe("example-shared");
    expect(await readdir(f.directory)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("keeps failed file deletion durable for retry after a restart", async () => {
  const f = await fixture();
  try {
    const { id } = f.saved;
    await f.secrets.set(id, 1, "example-shared");
    const ref = f.catalog.credentialBinding(id)!.reference!;
    const path = join(f.directory, ref);
    await unlink(path);
    await mkdir(path);
    expect(await f.secrets.set(id, 2, null)).toEqual({ cleanupPending: true });
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
