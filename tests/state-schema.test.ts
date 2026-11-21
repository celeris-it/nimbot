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
      expect(read(path, "PRAGMA user_version")).toEqual({
        user_version: kind === "server" ? 2 : 1,
      });
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

it("migrates subprocess state with saved Telegram and Discord connections to optional ownership", () => {
  const path = fixture(
    "server-process",
    `${legacy("server-process")}
    PRAGMA application_id = 0x4e494d50;
    PRAGMA user_version = 1;
    INSERT INTO agents (id, name, owner_id, bot_id, bot_username, credential_ref)
      VALUES ('a', 'Agent', 42, 123, 'test_bot', 'telegram-ref');
    INSERT INTO agent_processes (agent_id, desired_state) VALUES ('a', 'running');
    INSERT INTO agent_host_credentials (agent_id, credential_ref) VALUES ('a', 'host-ref');
    INSERT INTO chat_bindings (agent_id, bot_id, owner_id, chat_id) VALUES ('a', 123, 42, 42);
    INSERT INTO agent_discord_connections (agent_id, bot_id, bot_username, owner_id, credential_ref)
      VALUES ('a', '456', 'discord_bot', '789', 'discord-ref');
    INSERT INTO tasks (id, agent_id, bot_id, chat_id, prompt, status, created_at, updated_at)
      VALUES ('t', 'a', 123, 42, 'saved', 'queued', 1, 1);
    INSERT INTO schedules (id, agent_id, name, prompt, cadence_kind, timezone, enabled, created_at, updated_at, webhook_token, delivery_channel)
      VALUES ('s', 'a', 'Saved', 'Prompt', 'webhook', 'UTC', 1, 1, 1, 'saved-token', 'discord');
    `,
  );
  prepareStateSchema(path, "server-process");
  prepareStateSchema(path, "server-process");
  expect(read(path, "PRAGMA user_version")).toEqual({ user_version: 2 });
  expect(read(path, "PRAGMA foreign_key_check")).toBeUndefined();
  expect(
    read(path, "SELECT owner_id, bot_id, credential_ref FROM agents"),
  ).toEqual({
    owner_id: 42,
    bot_id: 123,
    credential_ref: "telegram-ref",
  });
  expect(read(path, "SELECT desired_state FROM agent_processes")).toEqual({
    desired_state: "running",
  });
  expect(
    read(path, "SELECT credential_ref FROM agent_host_credentials"),
  ).toEqual({ credential_ref: "host-ref" });
  expect(read(path, "SELECT chat_id FROM chat_bindings")).toEqual({
    chat_id: 42,
  });
  expect(
    read(path, "SELECT credential_ref FROM agent_discord_connections"),
  ).toEqual({ credential_ref: "discord-ref" });
  expect(read(path, "SELECT status FROM tasks")).toEqual({ status: "queued" });
  expect(read(path, "SELECT delivery_channel FROM schedules")).toEqual({
    delivery_channel: "discord",
  });
  const db = new DatabaseSync(path);
  try {
    db.exec("INSERT INTO agents (id, name) VALUES ('b', 'Unlinked')");
    expect(
      db.prepare("SELECT owner_id FROM agents WHERE id = 'b'").get(),
    ).toEqual({ owner_id: null });
  } finally {
    db.close();
  }
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

it.each([0, 1])(
  "upgrades populated server schema %i with task references and history",
  (version) => {
    const path = fixture(
      "server",
      `${legacy("server")}
    PRAGMA user_version = ${version};
    INSERT INTO agents (id, name, owner_id) VALUES ('a', 'Agent', 42);
    INSERT INTO tasks (seq, id, agent_id, bot_id, chat_id, prompt, status, created_at, updated_at)
      VALUES (10, 't', 'a', 1, 42, 'queued', 'queued', 1, 1),
             (20, 'deleted', 'a', 1, 42, 'old', 'completed', 1, 1);
    DELETE FROM tasks WHERE id = 'deleted';
    INSERT INTO schedules (id, agent_id, name, prompt, cadence_kind, timezone, enabled, created_at, updated_at, webhook_token)
      VALUES ('s', 'a', 'Saved', 'Prompt', 'webhook', 'UTC', 1, 1, 1, 'saved-token');
    INSERT INTO schedule_runs (id, schedule_id, agent_id, scheduled_for, outcome, task_id, created_at)
      VALUES ('r', 's', 'a', 1, 'enqueued', 't', 1);
  `,
    );
    prepareStateSchema(path, "server", { existing: true });
    expect(
      read(path, "SELECT delivery_channel, webhook_token FROM schedules"),
    ).toEqual({
      delivery_channel: "telegram",
      webhook_token: "saved-token",
    });
    expect(read(path, "SELECT seq, id, status FROM tasks")).toEqual({
      seq: 10,
      id: "t",
      status: "queued",
    });
    expect(read(path, "SELECT task_id FROM schedule_runs")).toEqual({
      task_id: "t",
    });
    expect(
      read(path, "SELECT seq FROM sqlite_sequence WHERE name = 'tasks'"),
    ).toEqual({ seq: 20 });
    expect(read(path, "PRAGMA foreign_key_check")).toBeUndefined();
  },
);
