import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { BACKUP_DIRECTORY, createArchive, validateArchive } from "./archive.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nimbot-archive-"));
  directories.push(directory);
  const state = join(directory, "state");
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(state, "server.sqlite"), "database", { mode: 0o600 });
  await mkdir(join(state, "agents"));
  await mkdir(join(state, BACKUP_DIRECTORY));
  await writeFile(
    join(state, BACKUP_DIRECTORY, "secret-temporary"),
    "excluded",
  );
  return {
    directory,
    state,
    archive: join(directory, "backup.tar.gz"),
    staging: join(directory, "staging"),
  };
}

it("round trips persistent files, private modes, long paths and symbolic links without following them", async () => {
  const { directory, state, archive, staging } = await fixture();
  const longName = "a".repeat(180);
  await writeFile(join(state, "agents", longName), "workspace", {
    mode: 0o640,
  });
  await symlink("/outside/unavailable", join(state, "agents", "external-link"));
  await symlink(longName, join(state, "agents", "local-link"));
  const manifest = await createArchive(
    state,
    archive,
    "build-one",
    1024 * 1024,
  );
  expect(
    manifest.files.some((entry) => entry.path.includes(BACKUP_DIRECTORY)),
  ).toBe(false);
  expect((await stat(archive)).mode & 0o777).toBe(0o600);
  const restored = await validateArchive(
    archive,
    staging,
    "build-one",
    1024 * 1024,
  );
  expect(restored).toEqual(manifest);
  expect(
    await readFile(join(staging, "data", "agents", longName), "utf8"),
  ).toBe("workspace");
  expect(await readlink(join(staging, "data", "agents", "external-link"))).toBe(
    "/outside/unavailable",
  );
  expect(
    (await stat(join(staging, "data", "agents", longName))).mode & 0o777,
  ).toBe(0o640);
  expect(
    await readFile(join(directory, "state", "server.sqlite"), "utf8"),
  ).toBe("database");
});

it("rejects incompatible builds before extracting files and cleans staging", async () => {
  const { state, archive, staging } = await fixture();
  await createArchive(state, archive, "build-one", 1024 * 1024);
  await expect(
    validateArchive(archive, staging, "build-two", 1024 * 1024),
  ).rejects.toThrow("same Nimbot build");
  await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
});

it("omits managed temporary and cache contents before size checks while preserving empty directories", async () => {
  const { state, archive, staging } = await fixture();
  const excluded = [
    "agents/agent-one/tmp",
    "agents/agent-one/engine/cache",
    "ai-providers/agents/management/tmp",
    "ai-providers/agents/management/engine/cache",
  ];
  for (const path of excluded) {
    await mkdir(join(state, path), { recursive: true, mode: 0o750 });
    await mkdir(join(state, path, "nested"), { mode: 0o700 });
    const transient = join(state, path, "nested", ".bun-native.so");
    await writeFile(transient, "temporary runtime binary");
    await truncate(transient, 2 * 1024 * 1024);
  }
  const manifest = await createArchive(
    state,
    archive,
    "build-one",
    1024 * 1024,
  );
  await validateArchive(archive, staging, "build-one", 1024 * 1024);
  for (const path of excluded) {
    expect(manifest.files.find((entry) => entry.path === path)).toMatchObject({
      type: "directory",
      mode: 0o750,
      size: 0,
    });
    expect(
      manifest.files.some((entry) => entry.path.startsWith(`${path}/`)),
    ).toBe(false);
    const restored = await stat(join(staging, "data", path));
    expect(restored.isDirectory()).toBe(true);
    expect(restored.mode & 0o777).toBe(0o750);
    await expect(
      stat(join(staging, "data", path, "nested")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await stat(join(state, path, "nested", ".bun-native.so"))).size,
    ).toBe(2 * 1024 * 1024);
  }
});

it("retains persistent executables, snapshots, credentials and similarly named directories", async () => {
  const { state, archive, staging } = await fixture();
  const retained = [
    "agents/agent-one/workspace/tmp/tool.node",
    "agents/agent-one/workspace/cache/tool.so",
    "agents/agent-one/home/.cache/tool",
    "agents/agent-one/engine/config/settings.json",
    "agents/agent-one/engine/data/opencode/opencode.db",
    "agents/agent-one/engine/state/state.json",
    "agents/agent-one/tasks/memory.sqlite",
    "agents/agent-one/browser/profile",
    "agents/agent-one/tmp-extra/tool",
    "agents/agent-one/engine/cache-extra/tool",
    "agents/invalid.id/tmp/tool",
    "ai-providers/agents/other/tmp/tool",
    "ai-providers/agents/management/home/tool",
    "ai-providers/opencode.db",
    "host-secrets/token",
    "server.sqlite.bak-v8",
    "server.sqlite.github-app-v7",
    "mcp-runtime/npm-cache/tool",
    "mcp-runtime/python/bin/python",
    "other/agents/agent-one/tmp/tool",
  ];
  for (const path of retained) {
    await mkdir(dirname(join(state, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(state, path), "persistent executable or state", {
      mode: 0o750,
    });
  }
  const manifest = await createArchive(
    state,
    archive,
    "build-one",
    1024 * 1024,
  );
  await validateArchive(archive, staging, "build-one", 1024 * 1024);
  for (const path of retained) {
    expect(manifest.files.find((entry) => entry.path === path)?.type).toBe(
      "file",
    );
    expect(await readFile(join(staging, "data", path), "utf8")).toBe(
      "persistent executable or state",
    );
    expect((await stat(join(staging, "data", path))).mode & 0o777).toBe(0o750);
  }
});

it("preserves symbolic links at runtime directory paths without traversing targets", async () => {
  const { state, archive, staging } = await fixture();
  await mkdir(join(state, "agents", "agent-one", "engine"), {
    recursive: true,
  });
  const paths = ["agents/agent-one/tmp", "agents/agent-one/engine/cache"];
  for (const path of paths)
    await symlink("/outside/missing-target", join(state, path));
  const manifest = await createArchive(
    state,
    archive,
    "build-one",
    1024 * 1024,
  );
  await validateArchive(archive, staging, "build-one", 1024 * 1024);
  for (const path of paths) {
    expect(manifest.files.find((entry) => entry.path === path)?.type).toBe(
      "symlink",
    );
    expect(await readlink(join(staging, "data", path))).toBe(
      "/outside/missing-target",
    );
  }
});

it("accepts older inventories containing runtime cache files", async () => {
  const { state, archive, staging } = await fixture();
  const original = "agents/agent-one/engine/state";
  const legacy = "agents/agent-one/engine/cache";
  await mkdir(join(state, original), { recursive: true });
  await writeFile(join(state, original, "tool.node"), "legacy native library");
  await createArchive(state, archive, "build-one", 1024 * 1024);
  // Both paths have the same byte length. Change only manifest and PAX path payloads.
  const contents = gunzipSync(await readFile(archive));
  let offset = contents.indexOf(original);
  while (offset !== -1) {
    contents.write(legacy, offset, "utf8");
    offset = contents.indexOf(original, offset + original.length);
  }
  await writeFile(archive, gzipSync(contents));
  const manifest = await validateArchive(
    archive,
    staging,
    "build-one",
    1024 * 1024,
  );
  expect(
    manifest.files.some((entry) => entry.path === `${legacy}/tool.node`),
  ).toBe(true);
  expect(
    await readFile(join(staging, "data", legacy, "tool.node"), "utf8"),
  ).toBe("legacy native library");
});

it("rejects corrupted file contents even when gzip and tar remain valid", async () => {
  const { state, archive, staging } = await fixture();
  await createArchive(state, archive, "build-one", 1024 * 1024);
  const contents = gunzipSync(await readFile(archive));
  const index = contents.indexOf(Buffer.from("database"));
  expect(index).toBeGreaterThan(0);
  contents[index] = "X".charCodeAt(0);
  await writeFile(archive, gzipSync(contents));
  await expect(
    validateArchive(archive, staging, "build-one", 1024 * 1024),
  ).rejects.toThrow("checksum mismatch");
});

it("rejects truncated archives and configured size overruns", async () => {
  const { state, archive, staging } = await fixture();
  await expect(createArchive(state, archive, "build-one", 3)).rejects.toThrow(
    "size limit",
  );
  await createArchive(state, archive, "build-one", 1024 * 1024);
  const contents = await readFile(archive);
  await writeFile(archive, contents.subarray(0, contents.length - 20));
  await expect(
    validateArchive(archive, staging, "build-one", 1024 * 1024),
  ).rejects.toThrow();
});

async function replaceManifest(
  archive: string,
  change: (manifest: import("./archive.js").BackupManifest) => void,
) {
  const contents = gunzipSync(await readFile(archive));
  const size = Number.parseInt(
    contents.subarray(124, 136).toString().replace(/\0.*$/s, ""),
    8,
  );
  const manifest = JSON.parse(
    contents.subarray(512, 512 + size).toString("utf8"),
  );
  change(manifest);
  const metadata = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.from(contents.subarray(0, 512));
  header.write(
    metadata.length.toString(8).padStart(11, "0") + "\0",
    124,
    12,
    "ascii",
  );
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(7, "0") + "\0", 148, 8, "ascii");
  await writeFile(
    archive,
    gzipSync(
      Buffer.concat([
        header,
        metadata,
        Buffer.alloc((512 - (metadata.length % 512)) % 512),
        contents.subarray(512 + Math.ceil(size / 512) * 512),
      ]),
    ),
  );
}

it("rejects manifest paths that traverse outside staging", async () => {
  const { state, archive, staging } = await fixture();
  await createArchive(state, archive, "build-one", 1024 * 1024);
  await replaceManifest(archive, (manifest) => {
    manifest.files.at(-1)!.path = "../escaped";
  });
  await expect(
    validateArchive(archive, staging, "build-one", 1024 * 1024),
  ).rejects.toThrow("Invalid or duplicate backup path");
});

it("rejects duplicate manifest paths", async () => {
  const { state, archive, staging } = await fixture();
  await createArchive(state, archive, "build-one", 1024 * 1024);
  await replaceManifest(archive, (manifest) => {
    manifest.files.push(manifest.files.at(-1)!);
  });
  await expect(
    validateArchive(archive, staging, "build-one", 1024 * 1024),
  ).rejects.toThrow("Invalid or duplicate backup path");
});

it("rejects files beneath a symbolic link before extraction", async () => {
  const { state, archive, staging } = await fixture();
  await symlink("/tmp", join(state, "agents", "link"));
  await createArchive(state, archive, "build-one", 1024 * 1024);
  await replaceManifest(archive, (manifest) => {
    manifest.files.at(-1)!.path = "agents/link/escaped";
  });
  await expect(
    validateArchive(archive, staging, "build-one", 1024 * 1024),
  ).rejects.toThrow("parent directory is missing or unsafe");
});

it("preserves an existing export when exclusive output creation fails", async () => {
  const { state, archive } = await fixture();
  await writeFile(archive, "previous export");
  await expect(
    createArchive(state, archive, "build-one", 1024 * 1024),
  ).rejects.toThrow();
  expect(await readFile(archive, "utf8")).toBe("previous export");
});
