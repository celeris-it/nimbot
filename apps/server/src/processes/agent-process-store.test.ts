import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { prepareStateSchema } from "../../../../scripts/state-schema.mjs";
import { openAgentRegistry } from "../agents/agent-registry.js";
import { openAgentProcessStore } from "./agent-process-store.js";
import { openProcessHostCredentials } from "./process-host-credentials.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nimbot-process-store-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "server.sqlite");
  const store = openAgentProcessStore(path);
  cleanup.push(() => store.close());
  const db = new DatabaseSync(path);
  cleanup.push(() => db.close());
  db.exec(
    "INSERT INTO agents (id,name,owner_id) VALUES ('first','First',42), ('second','Second',42)",
  );
  return { directory, path, store, db };
}

it("initializes a versioned fresh Server schema without Docker state", async () => {
  const { path, db, store } = await fixture();
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(7);
  expect(db.prepare("PRAGMA application_id").get()?.application_id).toBe(
    0x4e494d50,
  );
  const names = db
    .prepare("SELECT name FROM sqlite_schema")
    .all()
    .map((row) => row.name);
  for (const table of [
    "agent_processes",
    "agents",
    "tasks",
    "schedules",
    "delegations",
    "agent_host_credentials",
  ])
    expect(names).toContain(table);
  expect(names.join(" ")).not.toMatch(/container|provisioning|recovery/);
  expect(
    db
      .prepare("PRAGMA table_info(agents)")
      .all()
      .map((row) => row.name),
  ).not.toContain("container_ref");
  expect(
    db
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((row) => row.name),
  ).toContain("discord_attachment");
  expect(
    db
      .prepare("PRAGMA table_info(schedules)")
      .all()
      .map((row) => row.name),
  ).toContain("delivery_channel");
  store.create("first");
  store.setDesiredState("first", "running");
  const reopened = openAgentProcessStore(path);
  try {
    expect(reopened.list()).toEqual([
      { agentId: "first", desiredState: "running" },
    ]);
  } finally {
    reopened.close();
  }
  expect(() => prepareStateSchema(path, "server")).toThrow(
    "Subprocess Server state",
  );
});

it("persists desired state and excludes missing, deleted and removed agents", async () => {
  const { store, db } = await fixture();
  expect(() => store.create("missing")).toThrow("unavailable");
  expect(() => store.setDesiredState("first", "running")).toThrow(
    "unavailable",
  );
  store.create("first");
  store.create("second");
  store.setDesiredState("first", "running");
  store.create("first");
  expect(store.list()[0]).toEqual({
    agentId: "first",
    desiredState: "running",
  });
  db.exec("UPDATE agents SET deleted_at = 1 WHERE id = 'first'");
  expect(store.list()).toEqual([
    { agentId: "second", desiredState: "stopped" },
  ]);
  expect(() => store.setDesiredState("first", "running")).toThrow(
    "unavailable",
  );
  expect(() => store.create("first")).toThrow("unavailable");
  expect(() => store.getHostCredentialRef("first")).toThrow("unavailable");
  store.remove("second");
  expect(store.list()).toEqual([]);
  expect(
    db.prepare("SELECT id FROM agents WHERE id = 'second'").get(),
  ).toBeDefined();
});

it.each(["unversioned", "versioned"])(
  "rejects %s Docker Server state without modifying it",
  async (version) => {
    const directory = await mkdtemp(join(tmpdir(), "nimbot-old-state-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "server.sqlite");
    if (version === "versioned") prepareStateSchema(path, "server");
    else {
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE agents (id TEXT PRIMARY KEY)");
      db.close();
    }
    const before = await readFile(path);
    expect(() => openAgentProcessStore(path)).toThrow(
      "fresh subprocess installation is required",
    );
    expect(await readFile(path)).toEqual(before);
    expect(() => openAgentRegistry(path)).toThrow(
      "fresh subprocess installation is required",
    );
    expect(await readFile(path)).toEqual(before);
  },
);

it("retains one private token per agent across reopen and concurrent initialization", async () => {
  const { directory, path, store, db } = await fixture();
  store.create("first");
  store.create("second");
  const secretDirectory = join(directory, "host-secrets");
  const credentials = await openProcessHostCredentials(secretDirectory, store);
  const tokens = await Promise.all([
    credentials.token("first"),
    credentials.token("first"),
    credentials.token("second"),
  ]);
  expect(tokens[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(tokens[0]).toBe(tokens[1]);
  expect(tokens[0]).not.toBe(tokens[2]);
  expect(await readdir(secretDirectory)).toHaveLength(2);
  const reference = store.getHostCredentialRef("first")!;
  expect(
    (await stat(join(secretDirectory, reference.slice(5)))).mode & 0o777,
  ).toBe(0o600);
  expect((await stat(secretDirectory)).mode & 0o777).toBe(0o700);
  expect(
    JSON.stringify(db.prepare("SELECT * FROM agent_host_credentials").all()),
  ).not.toContain(tokens[0]);
  const reopened = openAgentProcessStore(path);
  try {
    const restored = await openProcessHostCredentials(
      secretDirectory,
      reopened,
    );
    expect(await restored.token("first")).toBe(tokens[0]);
  } finally {
    reopened.close();
  }
  await unlink(join(secretDirectory, reference.slice(5)));
  await expect(credentials.token("first")).rejects.toThrow();
  expect(store.getHostCredentialRef("first")).toBe(reference);
  expect(await readdir(secretDirectory)).toHaveLength(1);
});

it("rejects corrupt and permissive tokens without rotation and cleans failed candidates", async () => {
  const { directory, store } = await fixture();
  store.create("first");
  const secretDirectory = join(directory, "host-secrets");
  const credentials = await openProcessHostCredentials(secretDirectory, store);
  await credentials.token("first");
  const reference = store.getHostCredentialRef("first")!;
  const file = join(secretDirectory, reference.slice(5));
  await writeFile(file, "corrupt");
  await expect(credentials.token("first")).rejects.toThrow(
    "Invalid Host credential",
  );
  await chmod(file, 0o644);
  await expect(credentials.token("first")).rejects.toThrow("must be private");
  const failing = await openProcessHostCredentials(secretDirectory, {
    getHostCredentialRef: () => undefined,
    claimHostCredential: () => {
      throw new Error("Failed commit");
    },
  });
  await expect(failing.token("second")).rejects.toThrow("Failed commit");
  expect(await readdir(secretDirectory)).toEqual([reference.slice(5)]);
  expect(store.getHostCredentialRef("first")).toBe(reference);
});
