import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, open, rename, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { log } from "../logger.js";
import {
  createArchive,
  DEFAULT_BACKUP_MAX_BYTES,
  validateArchive,
  type BackupManifest,
} from "./archive.js";
import {
  applyRestore,
  commitRestore,
  recoverRestore,
  removeBackupTree,
} from "./recovery.js";

const retentionMs = 24 * 60 * 60 * 1000;

export class BackupError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 | 413 | 503 = 400,
  ) {
    super(message);
  }
}

export function readBackupMaxBytes(env: NodeJS.ProcessEnv): number {
  const bytes = Number(
    env.BACKUP_MAX_BYTES?.trim() || DEFAULT_BACKUP_MAX_BYTES,
  );
  if (!Number.isSafeInteger(bytes) || bytes < 1)
    throw new Error("BACKUP_MAX_BYTES must be a positive safe integer.");
  return bytes;
}

export interface BackupOperation {
  id: string;
  kind: "export" | "restore" | "validate";
  phase: string;
  status: "running" | "ready" | "completed" | "failed";
  error?: string;
}

export function createBackups(options: {
  stateDir: string;
  buildId: string;
  maxBytes: number;
  pause(): Promise<void>;
  resume(): Promise<void>;
  activateRuntime(): Promise<void>;
  invalidateSessions(): void;
}) {
  const directory = join(options.stateDir, ".nimbot-backups");
  let maintenance = true;
  let operation: BackupOperation | undefined;
  let download: { id: string; createdAt: string } | undefined;
  let restore: { id: string; manifest: BackupManifest } | undefined;
  let active = Promise.resolve();
  let downloading = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  function expireDownload() {
    if (downloading) {
      expiryTimer = setTimeout(expireDownload, 60_000);
      expiryTimer.unref();
      return;
    }
    download = undefined;
    void rm(join(directory, "export.tar.gz"), { force: true }).catch(() => {});
  }

  function available() {
    if (operation?.status === "running" || downloading)
      throw new BackupError("A backup operation is already running.", 409);
    if (maintenance)
      throw new BackupError("Nimbot is in maintenance mode.", 503);
  }

  async function resume(unlock = true) {
    operation!.phase = "reopening";
    await options.resume();
    if (unlock) {
      try {
        await options.activateRuntime();
      } catch (error) {
        await options.pause();
        throw error;
      }
      maintenance = false;
    }
  }

  function start(kind: BackupOperation["kind"], run: () => Promise<void>) {
    available();
    operation = {
      id: randomUUID(),
      kind,
      phase: kind === "validate" ? "uploading" : "pausing",
      status: "running",
    };
    active = Promise.resolve()
      .then(run)
      .catch((cause: unknown) => {
        log.error("server.backup_failed", {
          kind: operation!.kind,
          phase: operation!.phase,
          code: (cause as NodeJS.ErrnoException | undefined)?.code,
          hint: "Check backup compatibility, filesystem permissions and free disk space.",
        });
        // Paths, credentials and arbitrary filesystem errors never reach the panel.
        operation!.status = "failed";
        operation!.phase = "failed";
        operation!.error = maintenance
          ? "Backup recovery failed. Nimbot remains in maintenance mode."
          : "The backup operation failed. Check the file and available disk space.";
      });
    return { ...operation };
  }

  async function clearPreview() {
    restore = undefined;
    await rm(join(directory, "upload.tar.gz"), { force: true });
    await removeBackupTree(join(directory, "staging"));
  }

  function validateState(manifest: BackupManifest) {
    if (
      !manifest.files.some(
        (file) => file.path === "server.sqlite" && file.type === "file",
      )
    )
      throw new Error("Backup does not contain a Nimbot installation.");
    const db = new DatabaseSync(
      join(directory, "staging", "data", "server.sqlite"),
      { readOnly: true },
    );
    try {
      if (
        db.prepare("PRAGMA application_id").get()?.application_id !==
          0x4e494d50 ||
        db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok"
      )
        throw new Error("Backup contains an invalid Nimbot database.");
    } finally {
      db.close();
    }
  }

  async function pause() {
    maintenance = true;
    operation!.phase = "pausing";
    await options.pause();
  }

  async function exportBackup() {
    await clearPreview();
    download = undefined;
    clearTimeout(expiryTimer);
    await rm(join(directory, "export.tar.gz"), { force: true });
    await pause();
    try {
      operation!.phase = "archiving";
      const manifest = await createArchive(
        options.stateDir,
        join(directory, "export.tmp"),
        options.buildId,
        options.maxBytes,
      );
      // Validate our own output before offering it for recovery.
      operation!.phase = "validating";
      await validateArchive(
        join(directory, "export.tmp"),
        join(directory, "check"),
        options.buildId,
        options.maxBytes,
      );
      await rename(
        join(directory, "export.tmp"),
        join(directory, "export.tar.gz"),
      );
      download = { id: operation!.id, createdAt: manifest.createdAt };
      expiryTimer = setTimeout(expireDownload, retentionMs);
      expiryTimer.unref();
    } finally {
      await removeBackupTree(join(directory, "check"));
      await rm(join(directory, "export.tmp"), { force: true });
      await resume();
    }
    operation!.status = "ready";
    operation!.phase = "ready";
  }

  async function apply() {
    const staged = restore!;
    await pause();
    try {
      operation!.phase = "restoring";
      await applyRestore(options.stateDir, join(directory, "staging", "data"));
      await resume(false);
    } catch (error) {
      maintenance = true;
      operation!.phase = "rolling_back";
      // A failed reopen may have allocated stores or children. Close them first.
      await options.pause();
      await recoverRestore(options.stateDir);
      await resume();
      throw error;
    }
    await commitRestore(options.stateDir);
    try {
      if (restore?.id === staged.id) await clearPreview();
      await options.activateRuntime();
    } catch (error) {
      // The replacement is committed. Preserve it and stop partially started work.
      await options.pause();
      throw error;
    }
    options.invalidateSessions();
    maintenance = false;
    operation!.phase = "completed";
    operation!.status = "completed";
  }

  return {
    get maintenance() {
      return maintenance;
    },
    failMaintenance() {
      maintenance = true;
    },
    activate() {
      maintenance = false;
    },
    async initialize() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await recoverRestore(options.stateDir);
      // Downloads and uploads belong to the previous process and have no live IDs.
      for (const name of [
        "export.tmp",
        "export.tar.gz",
        "upload.tar.gz",
        "staging",
        "check",
      ])
        await removeBackupTree(join(directory, name));
    },
    settled() {
      return active;
    },
    status() {
      const validDownload =
        download && Date.now() - Date.parse(download.createdAt) < retentionMs;
      const preview = restore && {
        id: restore.id,
        manifest: {
          createdAt: restore.manifest.createdAt,
          buildId: restore.manifest.buildId,
          totalBytes: restore.manifest.files.reduce(
            (bytes, file) => bytes + file.size,
            0,
          ),
          fileCount: restore.manifest.files.length,
        },
      };
      return {
        operation: operation && { ...operation },
        download: validDownload ? download : undefined,
        restore: preview,
        maintenance,
        maxBytes: options.maxBytes,
      };
    },
    export() {
      return start("export", exportBackup);
    },
    async upload(body: ReadableStream<Uint8Array>) {
      let receive!: () => void;
      let reject!: (error: unknown) => void;
      const received = new Promise<void>((resolve, fail) => {
        receive = resolve;
        reject = fail;
      });
      const started = start("validate", async () => {
        await received;
        operation!.phase = "validating";
        const manifest = await validateArchive(
          join(directory, "upload.tar.gz"),
          join(directory, "staging"),
          options.buildId,
          options.maxBytes,
        );
        validateState(manifest);
        restore = { id: started.id, manifest };
        operation!.phase = "ready";
        operation!.status = "ready";
      });
      try {
        await clearPreview();
        let size = 0;
        const disk = await statfs(directory);
        const free = Number(disk.bavail) * Number(disk.bsize);
        const limit = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > options.maxBytes)
              return callback(
                new BackupError(
                  "Backup exceeds the configured size limit.",
                  413,
                ),
              );
            if (size > free - 1024 * 1024)
              return callback(
                new BackupError("Not enough disk space for the backup."),
              );
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(
            body as import("node:stream/web").ReadableStream<Uint8Array>,
          ),
          limit,
          createWriteStream(join(directory, "upload.tar.gz"), {
            flags: "wx",
            mode: 0o600,
          }),
        );
        receive();
        return started;
      } catch (error) {
        reject(error);
        await active;
        await clearPreview();
        throw error;
      }
    },
    restore(id: string) {
      available();
      if (!restore || restore.id !== id)
        throw new BackupError("No validated backup is available.", 409);
      return start("restore", apply);
    },
    async download(id: string) {
      if (
        !download ||
        id !== download.id ||
        Date.now() - Date.parse(download.createdAt) >= retentionMs
      )
        throw new BackupError(
          "Backup download has expired. Create another backup.",
          404,
        );
      if (operation?.status === "running")
        throw new BackupError("A backup operation is already running.", 409);
      // Reserve before awaiting stat, so a new export cannot unlink this file.
      downloading++;
      try {
        const file = await open(join(directory, "export.tar.gz"), "r");
        try {
          const info = await file.stat();
          const stream = file.createReadStream();
          stream.once("close", () => {
            downloading--;
          });
          return { stream, size: info.size };
        } catch (error) {
          await file.close();
          throw error;
        }
      } catch (error) {
        downloading--;
        throw error;
      }
    },
  };
}
