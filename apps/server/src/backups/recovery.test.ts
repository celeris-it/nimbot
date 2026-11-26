import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BACKUP_DIRECTORY } from "./archive.js";
import {
  applyRestore,
  commitRestore,
  recoverRestore,
  removeBackupTree,
} from "./recovery.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.mocked(rm).mockReset();
  for (const directory of directories.splice(0))
    await removeBackupTree(directory);
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nimbot-recovery-"));
  directories.push(directory);
  const state = join(directory, "state");
  const control = join(state, BACKUP_DIRECTORY);
  const staged = join(control, "staging", "data");
  await mkdir(staged, { recursive: true, mode: 0o700 });
  await writeFile(join(state, "server.sqlite"), "original");
  await writeFile(join(state, "old-only"), "old");
  await writeFile(join(staged, "server.sqlite"), "restored");
  await writeFile(join(staged, "new-only"), "new");
  return { directory, state, control, staged };
}

it("retains the volume root and original state until restored services verify successfully", async () => {
  const { state, control, staged } = await fixture();
  await applyRestore(state, staged);
  expect(await readFile(join(state, "server.sqlite"), "utf8")).toBe("restored");
  expect(
    await readFile(join(control, "previous", "server.sqlite"), "utf8"),
  ).toBe("original");
  await commitRestore(state);
  expect(await recoverRestore(state)).toBe(false);
  expect(await readFile(join(state, "server.sqlite"), "utf8")).toBe("restored");
  expect(
    await readFile(join(control, "previous", "server.sqlite"), "utf8"),
  ).toBe("original");
});

it("rolls back failed restored-service verification and removes newly introduced entries", async () => {
  const { state, staged } = await fixture();
  await applyRestore(state, staged);
  expect(await recoverRestore(state)).toBe(true);
  expect((await readdir(state)).sort()).toEqual([
    BACKUP_DIRECTORY,
    "old-only",
    "server.sqlite",
  ]);
  expect(await readFile(join(state, "server.sqlite"), "utf8")).toBe("original");
  expect(await recoverRestore(state)).toBe(false);
});

it.each([0, 1, 2, 3, 4])(
  "recovers a process interruption after %i entry moves",
  async (moves) => {
    const { state, control, staged } = await fixture();
    const previous = join(control, "previous");
    await mkdir(previous);
    const oldNames = ["server.sqlite", "old-only"];
    const newNames = ["server.sqlite", "new-only"];
    await writeFile(
      join(control, "restore-journal.json"),
      JSON.stringify({ version: 1, committed: false, oldNames, newNames }),
    );
    const actions = [
      [join(state, "server.sqlite"), join(previous, "server.sqlite")],
      [join(state, "old-only"), join(previous, "old-only")],
      [join(staged, "server.sqlite"), join(state, "server.sqlite")],
      [join(staged, "new-only"), join(state, "new-only")],
    ];
    for (const [source, destination] of actions.slice(0, moves))
      await rename(source!, destination!);
    expect(await recoverRestore(state)).toBe(true);
    expect(await readFile(join(state, "server.sqlite"), "utf8")).toBe(
      "original",
    );
    expect(await readFile(join(state, "old-only"), "utf8")).toBe("old");
    await expect(readFile(join(state, "new-only"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("can resume a partially completed rollback without removing already recovered originals", async () => {
  const { state, control, staged } = await fixture();
  await applyRestore(state, staged);
  await rm(join(state, "server.sqlite"));
  await rename(
    join(control, "previous", "server.sqlite"),
    join(state, "server.sqlite"),
  );
  await recoverRestore(state);
  expect(await readFile(join(state, "server.sqlite"), "utf8")).toBe("original");
  expect(await readFile(join(state, "old-only"), "utf8")).toBe("old");
});

it("keeps committed state when interrupted before journal cleanup", async () => {
  const { state, control, staged } = await fixture();
  await applyRestore(state, staged);
  const path = join(control, "restore-journal.json");
  const journal = JSON.parse(await readFile(path, "utf8"));
  journal.committed = true;
  await writeFile(path, JSON.stringify(journal));
  expect(await recoverRestore(state)).toBe(false);
  expect(await readFile(join(state, "server.sqlite"), "utf8")).toBe("restored");
});

it("rolls back restored read-only directories without following their symbolic links", async () => {
  const { state, staged } = await fixture();
  await mkdir(join(staged, "readonly"));
  await writeFile(join(staged, "readonly", "file"), "restored");
  await chmod(join(staged, "readonly"), 0o500);
  await applyRestore(state, staged);
  await recoverRestore(state);
  await expect(readFile(join(state, "readonly", "file"))).rejects.toMatchObject(
    { code: "ENOENT" },
  );
  expect(await readFile(join(state, "server.sqlite"), "utf8")).toBe("original");
});

it("keeps a durable committed marker when final journal cleanup fails", async () => {
  const { state, control, staged } = await fixture();
  await applyRestore(state, staged);
  vi.mocked(rm).mockRejectedValueOnce(new Error("Simulated cleanup failure"));
  await expect(commitRestore(state)).resolves.toBeUndefined();
  expect(
    JSON.parse(await readFile(join(control, "restore-journal.json"), "utf8"))
      .committed,
  ).toBe(true);
  expect(await readFile(join(state, "server.sqlite"), "utf8")).toBe("restored");
  expect(await recoverRestore(state)).toBe(false);
  expect(await readFile(join(state, "server.sqlite"), "utf8")).toBe("restored");
});

it("removes SQLite sidecars created during failed restored-runtime verification", async () => {
  const { state, staged } = await fixture();
  await applyRestore(state, staged);
  await writeFile(join(state, "server.sqlite-wal"), "new database WAL");
  await writeFile(
    join(state, "server.sqlite-shm"),
    "new database shared memory",
  );
  await mkdir(join(state, "fresh-runtime-state"));
  await writeFile(
    join(state, "fresh-runtime-state", "file"),
    "new runtime state",
  );
  await recoverRestore(state);
  expect((await readdir(state)).sort()).toEqual([
    BACKUP_DIRECTORY,
    "old-only",
    "server.sqlite",
  ]);
  expect(await readFile(join(state, "server.sqlite"), "utf8")).toBe("original");
});
