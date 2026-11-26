import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { createBackups, readBackupMaxBytes } from "./service.js";
import { createArchive } from "./archive.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), "nimbot-backup-service-"));
  directories.push(stateDir);
  const db = new DatabaseSync(join(stateDir, "server.sqlite"));
  db.exec(
    "PRAGMA application_id = 1313426768; CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('saved');",
  );
  db.close();
  await writeFile(join(stateDir, "note"), "saved");
  const pause = vi.fn(async () => {});
  const resume = vi.fn(async () => {});
  const invalidateSessions = vi.fn();
  const activateRuntime = vi.fn(async () => {});
  const backups = createBackups({
    stateDir,
    buildId: "test-build",
    maxBytes: 1024 ** 2,
    pause,
    resume,
    activateRuntime,
    invalidateSessions,
  });
  await backups.initialize();
  backups.activate();
  return {
    stateDir,
    backups,
    pause,
    resume,
    activateRuntime,
    invalidateSessions,
  };
}
function body(data: Uint8Array) {
  return Readable.toWeb(Readable.from([data])) as ReadableStream<Uint8Array>;
}

it("exports closed state, validates uploads, restores files and invalidates sessions", async () => {
  const { stateDir, backups, pause, resume, invalidateSessions } =
    await fixture();
  backups.export();
  expect(() => backups.export()).toThrow("already running");
  await backups.settled();
  expect(backups.status().operation?.status).toBe("ready");
  expect(pause).toHaveBeenCalledOnce();
  expect(resume).toHaveBeenCalledOnce();
  const download = await backups.download(backups.status().download!.id);
  expect(() => backups.export()).toThrow("already running");
  const chunks = [];
  for await (const chunk of download.stream) chunks.push(chunk);
  await writeFile(join(stateDir, "note"), "changed");
  const validation = await backups.upload(body(Buffer.concat(chunks)));
  await backups.settled();
  expect(backups.status().restore?.id).toBe(validation.id);
  backups.restore(validation.id);
  await backups.settled();
  expect(backups.status().operation?.status).toBe("completed");
  expect(await readFile(join(stateDir, "note"), "utf8")).toBe("saved");
  expect(invalidateSessions).toHaveBeenCalledOnce();
  expect(backups.maintenance).toBe(false);
  expect(
    await readFile(
      join(stateDir, ".nimbot-backups", "previous", "note"),
      "utf8",
    ),
  ).toBe("changed");
});

it("rolls back when restored runtime verification fails", async () => {
  const { stateDir, backups, resume, invalidateSessions } = await fixture();
  backups.export();
  await backups.settled();
  const data = await readFile(
    join(stateDir, ".nimbot-backups", "export.tar.gz"),
  );
  const uploaded = await backups.upload(body(data));
  await backups.settled();
  await writeFile(join(stateDir, "note"), "original");
  resume.mockRejectedValueOnce(new Error("Verification failed"));
  backups.restore(uploaded.id);
  await backups.settled();
  expect(backups.status().operation?.status).toBe("failed");
  expect(backups.maintenance).toBe(false);
  expect(await readFile(join(stateDir, "note"), "utf8")).toBe("original");
  expect(invalidateSessions).not.toHaveBeenCalled();
});

it("keeps maintenance active when closing runtime fails", async () => {
  const { backups, pause } = await fixture();
  pause.mockRejectedValueOnce(new Error("Still writing"));
  backups.export();
  await backups.settled();
  expect(backups.maintenance).toBe(true);
  expect(() => backups.export()).toThrow("maintenance");
});

it("invalidates sessions only after restored work can start", async () => {
  const { stateDir, backups, activateRuntime, invalidateSessions } =
    await fixture();
  backups.export();
  await backups.settled();
  const archive = await readFile(
    join(stateDir, ".nimbot-backups", "export.tar.gz"),
  );
  const uploaded = await backups.upload(body(archive));
  await backups.settled();
  let finish!: () => void;
  activateRuntime.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  backups.restore(uploaded.id);
  await vi.waitFor(() => expect(activateRuntime).toHaveBeenCalledTimes(2));
  expect(backups.maintenance).toBe(true);
  expect(invalidateSessions).not.toHaveBeenCalled();
  finish();
  await backups.settled();
  expect(invalidateSessions).toHaveBeenCalledOnce();
  expect(backups.maintenance).toBe(false);
});

it("rejects an otherwise valid archive without installation state", async () => {
  const { stateDir, backups } = await fixture();
  const empty = await mkdtemp(join(tmpdir(), "nimbot-empty-backup-"));
  directories.push(empty);
  const path = join(stateDir, ".nimbot-backups", "empty.tar.gz");
  await createArchive(empty, path, "test-build", 1024 ** 2);
  await backups.upload(body(await readFile(path)));
  await backups.settled();
  expect(backups.status().restore).toBeUndefined();
  expect(backups.status().operation?.status).toBe("failed");
  expect(backups.maintenance).toBe(false);
});

it("rejects oversized chunked uploads and releases the operation lock", async () => {
  const { backups } = await fixture();
  await expect(
    backups.upload(body(Buffer.alloc(1024 ** 2 + 1))),
  ).rejects.toThrow("size limit");
  expect(backups.status().operation?.status).toBe("failed");
  expect(() => backups.export()).not.toThrow();
  await backups.settled();
});

it("validates the configured backup byte limit", () => {
  expect(readBackupMaxBytes({})).toBe(10 * 1024 ** 3);
  for (const value of ["0", "-1", "NaN", "1.5", "9007199254740992"])
    expect(() => readBackupMaxBytes({ BACKUP_MAX_BYTES: value })).toThrow(
      "positive safe integer",
    );
});
