import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { BACKUP_DIRECTORY } from "./archive.js";
import { log } from "../logger.js";

const nameSchema = z
  .string()
  .min(1)
  .refine(
    (name) =>
      name !== "." &&
      name !== ".." &&
      name !== BACKUP_DIRECTORY &&
      !/[\\/\0]/.test(name),
  );
const journalSchema = z
  .object({
    version: z.literal(1),
    committed: z.boolean(),
    oldNames: z.array(nameSchema),
    newNames: z.array(nameSchema),
    oldModes: z
      .record(nameSchema, z.number().int().min(0).max(0o777))
      .default({}),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function removeBackupTree(path: string): Promise<void> {
  if (!(await exists(path))) return;
  const info = await lstat(path);
  if (info.isDirectory()) {
    await chmod(path, info.mode | 0o700);
    for (const name of await readdir(path))
      await removeBackupTree(join(path, name));
  }
  await rm(path, { recursive: true, force: true });
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function writeJournal(directory: string, value: Journal): Promise<void> {
  const temporary = join(directory, "restore-journal.tmp");
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, join(directory, "restore-journal.json"));
  await syncDirectory(directory);
}
async function durableMove(source: string, destination: string): Promise<void> {
  const info = await lstat(source);
  // Moving a directory between parents requires write access to update its parent entry.
  if (info.isDirectory()) await chmod(source, info.mode | 0o700);
  const directory = info.isDirectory() ? await open(source, "r") : undefined;
  let moved = false;
  try {
    await rename(source, destination);
    moved = true;
    if (directory) {
      await directory.chmod(info.mode & 0o777);
      await directory.sync();
    }
    await syncDirectory(dirname(source));
    await syncDirectory(dirname(destination));
  } finally {
    if (directory) {
      if (!moved) await directory.chmod(info.mode & 0o777);
      await directory.close();
    }
  }
}

/** Keep the original volume root mounted and swap only its immediate children. */
export async function applyRestore(
  stateDir: string,
  stagedDataDir: string,
): Promise<void> {
  const directory = join(stateDir, BACKUP_DIRECTORY);
  const stagingRelative = relative(resolve(directory), resolve(stagedDataDir));
  if (
    !stagingRelative ||
    stagingRelative.startsWith("..") ||
    resolve(stateDir) === resolve(stagedDataDir)
  )
    throw new Error("Restore staging must be inside the backup directory.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await exists(join(directory, "restore-journal.json")))
    throw new Error("A restore operation already requires recovery.");
  const newNames = await readdir(stagedDataDir);
  const oldNames = (await readdir(stateDir)).filter(
    (name) => name !== BACKUP_DIRECTORY,
  );
  const oldModes: Record<string, number> = {};
  for (const name of oldNames) {
    const info = await lstat(join(stateDir, name));
    if (info.isDirectory()) oldModes[name] = info.mode & 0o777;
  }
  const journal = journalSchema.parse({
    oldModes,
    version: 1,
    committed: false,
    oldNames,
    newNames,
  });
  const previous = join(directory, "previous");
  await removeBackupTree(previous);
  await mkdir(previous, { mode: 0o700 });
  await writeJournal(directory, journal);
  for (const name of oldNames)
    await durableMove(join(stateDir, name), join(previous, name));
  for (const name of newNames)
    await durableMove(join(stagedDataDir, name), join(stateDir, name));
}

export async function commitRestore(stateDir: string): Promise<void> {
  const directory = join(stateDir, BACKUP_DIRECTORY);
  const path = join(directory, "restore-journal.json");
  const handle = await open(path, "r");
  let journal: Journal;
  try {
    journal = journalSchema.parse(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
  await writeJournal(directory, { ...journal, committed: true });
  // Once the marker is durable, cleanup failure must never trigger rollback.
  try {
    await rm(path);
    await syncDirectory(directory);
  } catch {
    log.warn("server.restore_journal_cleanup_deferred");
  }
}

/** Call before opening any state, and after a failed verification of restored state. */
export async function recoverRestore(stateDir: string): Promise<boolean> {
  const directory = join(stateDir, BACKUP_DIRECTORY);
  const path = join(directory, "restore-journal.json");
  if (!(await exists(path))) return false;
  const handle = await open(path, "r");
  let journal: Journal;
  try {
    journal = journalSchema.parse(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
  if (!journal.committed) {
    const oldNames = new Set(journal.oldNames);
    // Runtime verification may create fresh SQLite sidecars or other root entries.
    // Remove every entry absent from the original snapshot before reopening old state.
    for (const name of await readdir(stateDir)) {
      if (name !== BACKUP_DIRECTORY && !oldNames.has(name)) {
        await removeBackupTree(join(stateDir, name));
        await syncDirectory(stateDir);
      }
    }
    for (const name of journal.oldNames) {
      const source = join(directory, "previous", basename(name));
      if (await exists(source)) {
        await removeBackupTree(join(stateDir, name));
        await durableMove(source, join(stateDir, name));
      }
    }
    for (const [name, mode] of Object.entries(journal.oldModes)) {
      if (!journal.oldNames.includes(name))
        throw new Error("Invalid restore mode record.");
      const restored = await open(join(stateDir, name), "r");
      try {
        await restored.chmod(mode);
        await restored.sync();
      } finally {
        await restored.close();
      }
    }
  }
  await rm(path);
  await syncDirectory(directory);
  return !journal.committed;
}
