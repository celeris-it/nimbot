import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { prepareStateSchema } from "../scripts/state-schema.mjs";

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true });
});
type Kind = Parameters<typeof prepareStateSchema>[1];

function fixture(kind: Kind, sql = "") {
  const dir = mkdtempSync(join(tmpdir(), "nimbot-schema-"));
  temporary.push(dir);
  const path = join(dir, `${kind}.sqlite`);
  if (sql) {
    const db = new DatabaseSync(path);
    db.exec(sql);
    db.close();
  }
  return path;
}

function legacy(kind: Kind) {
  return readFileSync(
    new URL(`../scripts/state-schema/${kind}-v1.sql`, import.meta.url),
    "utf8",
  );
}

function read(path: string, sql: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).get();
  } finally {
    db.close();
  }
}

it.each([
  [
    "server",
    "INSERT INTO agents (id, name, owner_id) VALUES ('a', 'saved', 1)",
    "SELECT name AS data FROM agents",
  ],
  [
    "tasks",
    "INSERT INTO tasks (id, prompt, status) VALUES ('t', 'saved', 'completed')",
    "SELECT prompt AS data FROM tasks",
  ],
  [
    "memory",
    "INSERT INTO memories (id,title,content,tags,created_at,updated_at) VALUES ('m','saved','body','[]',1,1)",
    "SELECT title AS data FROM memories",
  ],
] as const)(
  "versions existing %s without losing rows and initializes fresh state",
  (kind, insert, select) => {
    const database = fixture(kind, `${legacy(kind)}\n${insert}`);
    const fresh = fixture(kind);
    expect(read(database, "PRAGMA user_version")).toEqual({ user_version: 0 });
    for (const path of [database, fresh]) {
      prepareStateSchema(path, kind);
      prepareStateSchema(path, kind);
      expect(read(path, "PRAGMA user_version")).toEqual({ user_version: 1 });
    }
    expect(read(database, select)).toEqual({ data: "saved" });
  },
);

it("rejects unknown and future schemas", () => {
  const unknown = fixture("server", "CREATE TABLE agents (id TEXT)");
  expect(() => prepareStateSchema(unknown, "server")).toThrow(
    /server.sqlite: Schema differs/,
  );
  expect(read(unknown, "PRAGMA user_version")).toEqual({ user_version: 0 });
  const future = fixture("tasks", "PRAGMA user_version = 999");
  expect(() => prepareStateSchema(future, "tasks")).toThrow(
    /tasks.sqlite: Unsupported schema version 999/,
  );
});

it("rolls back the failed step and safely retries an ordered migration", () => {
  const database = fixture("server", legacy("server"));
  const first = (db: DatabaseSync) =>
    db.exec("ALTER TABLE agents ADD COLUMN custom TEXT");
  const failing = (db: DatabaseSync) =>
    db.exec("CREATE TABLE extra (id TEXT); SELECT * FROM absent");
  const last = (db: DatabaseSync) => db.exec("CREATE TABLE extra (id TEXT)");
  expect(() =>
    prepareStateSchema(database, "server", {
      existing: true,
      definition: { version: 3, migrations: { 2: first, 3: failing } },
    }),
  ).toThrow(/no such table: absent/);
  expect(read(database, "PRAGMA user_version")).toEqual({ user_version: 2 });
  expect(
    read(database, "SELECT name FROM sqlite_schema WHERE name = 'extra'"),
  ).toBeUndefined();
  prepareStateSchema(database, "server", {
    existing: true,
    definition: { version: 3, migrations: { 2: first, 3: last } },
  });
  expect(read(database, "PRAGMA user_version")).toEqual({ user_version: 3 });
});
