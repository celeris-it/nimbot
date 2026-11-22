import {
  chmod,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { agentProcessDirectories } from "./processes/agent-process-config.js";
import { providers, type ProviderId } from "./provider-contracts.js";

// These tables belong to the OpenCode version pinned in the Docker image.
const sharedTables = [
  "project",
  "workspace",
  "project_directory",
  "worktree",
  "blob",
  "instruction_blob",
];
const sessionTables = [
  "permission",
  "session_v2",
  "session_message",
  "session_part",
  "session_inbox",
  "instruction_entry",
  "instruction_state",
  "blob_ref",
  "schedule",
  "job",
  "event_sequence",
  "event",
];
type Row = Record<string, SQLOutputValue>;

function missing(error: NodeJS.ErrnoException) {
  if (error.code !== "ENOENT") throw error;
}

function openDatabase(path: string, readOnly = false) {
  const db = new DatabaseSync(path, { readOnly });
  return { db, [Symbol.dispose]: () => db.close() };
}

function tableExists(db: DatabaseSync, table: string) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table);
}

function transaction(db: DatabaseSync, operation: () => void) {
  db.exec("BEGIN IMMEDIATE");
  try {
    operation();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function copyTable(db: DatabaseSync, table: string, deduplicate = false) {
  const columns = (schema: "main" | "legacy") =>
    db
      .prepare(`PRAGMA ${schema}.table_info(${table})`)
      .all()
      .map(({ name }) => String(name))
      .sort();
  const names = columns("main");
  if (!names.length || !isDeepStrictEqual(names, columns("legacy")))
    throw new Error("Unsupported OpenCode database schema");
  const fields = names
    .map((name) => `"${name.replaceAll('"', '""')}"`)
    .join(", ");
  const where =
    table === "event" || table === "event_sequence"
      ? " WHERE aggregate_id IN (SELECT id FROM legacy.session_v2)"
      : "";
  db.exec(`
    INSERT ${deduplicate ? "OR IGNORE " : ""}INTO main.${table} (${fields})
    SELECT ${fields} FROM legacy.${table}${where}
  `);
}

function selectedCredentials(
  db: DatabaseSync,
  matches: Map<ProviderId, Row[]>,
) {
  const select = db.prepare(`
    SELECT * FROM credential WHERE integration_id = ?
    ORDER BY active DESC, time_created DESC, id DESC LIMIT 1
  `);
  for (const { id } of providers) {
    const row = select.get(id);
    if (!row) continue;
    const entries = matches.get(id) ?? [];
    entries.push(row);
    matches.set(id, entries);
  }
}

function sameCredential(left: Row, right: Row) {
  return (
    left.method_id === right.method_id &&
    left.connector_id === right.connector_id &&
    isDeepStrictEqual(
      JSON.parse(String(left.value)),
      JSON.parse(String(right.value)),
    )
  );
}

export async function prepareSharedEngine(
  state: string,
  agentIds: readonly string[],
) {
  const directory = resolve(state, "ai-providers");
  const database = resolve(directory, "opencode.db");
  if (!(await stat(directory).catch(missing))) {
    const sources = (
      await readdir(resolve(state, "agents"), { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      )
    )
      .filter(
        (entry) =>
          entry.isDirectory() && /^[a-z0-9][a-z0-9-]{0,47}$/.test(entry.name),
      )
      .map(({ name: id }) => ({
        id,
        path: resolve(
          agentProcessDirectories(state, id).data,
          "opencode",
          "opencode.db",
        ),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    const staging = resolve(state, ".ai-providers-import-v1");
    // A crash can leave a partial private copy. Start the import again from the source databases.
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { mode: 0o700 });
    try {
      const stagedDatabase = resolve(staging, "opencode.db");
      const credentials = new Map<ProviderId, Row[]>();
      let initialized = false;
      for (const source of sources) {
        const info = await stat(source.path).catch(missing);
        if (!info || !info.size) continue;
        using sourceDatabase = openDatabase(source.path, true);
        const legacy = sourceDatabase.db;
        // A Host interrupted before the first engine start may have an empty SQLite file.
        if (
          !legacy
            .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table'")
            .get()
        )
          continue;
        if (
          !tableExists(legacy, "migration") ||
          !tableExists(legacy, "credential") ||
          !tableExists(legacy, "session_v2")
        )
          throw new Error("Unsupported OpenCode database schema");
        if (agentIds.includes(source.id))
          selectedCredentials(legacy, credentials);
        if (!initialized) {
          legacy.prepare("VACUUM INTO ?").run(stagedDatabase);
          await chmod(stagedDatabase, 0o600);
          initialized = true;
          using destination = openDatabase(stagedDatabase);
          const { db } = destination;
          db.exec(`
            CREATE TABLE nimbot_imported_session (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL);
            CREATE TABLE nimbot_provider_reconnect (provider TEXT PRIMARY KEY);
            DELETE FROM credential;
            DELETE FROM control_account;
            DELETE FROM account;
          `);
          db.prepare(
            "INSERT INTO nimbot_imported_session SELECT id, ? FROM session_v2",
          ).run(source.id);
          continue;
        }
        const snapshot = resolve(staging, "source.db");
        legacy.prepare("VACUUM INTO ?").run(snapshot);
        try {
          using destination = openDatabase(stagedDatabase);
          const { db } = destination;
          db.prepare("ATTACH DATABASE ? AS legacy").run(snapshot);
          transaction(db, () => {
            for (const table of sharedTables) copyTable(db, table, true);
            for (const table of sessionTables)
              copyTable(db, table, table === "permission");
            db.prepare(
              "INSERT INTO nimbot_imported_session SELECT id, ? FROM legacy.session_v2",
            ).run(source.id);
          });
        } finally {
          await rm(snapshot, { force: true });
        }
      }

      if (initialized) {
        using destination = openDatabase(stagedDatabase);
        const { db } = destination;
        transaction(db, () => {
          const insert = db.prepare(`
            INSERT INTO credential (id, integration_id, label, value, connector_id,
              method_id, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
          `);
          const conflict = db.prepare(
            "INSERT INTO nimbot_provider_reconnect VALUES (?)",
          );
          for (const [id, [first, ...rest]] of credentials) {
            if (!first) continue;
            if (rest.some((row) => !sameCredential(first, row))) {
              conflict.run(id);
              continue;
            }
            insert.run(
              first.id!,
              id,
              first.label!,
              first.value!,
              first.connector_id!,
              first.method_id!,
              first.time_created!,
              first.time_updated!,
            );
          }
          db.exec(`
            CREATE TRIGGER nimbot_provider_reconnected AFTER INSERT ON credential
            BEGIN
              DELETE FROM nimbot_provider_reconnect WHERE provider = NEW.integration_id;
            END;
          `);
          if (db.prepare("PRAGMA foreign_key_check").get())
            throw new Error(
              "OpenCode database migration failed integrity checks",
            );
        });
        db.exec("PRAGMA journal_mode = DELETE");
      }
      await mkdir(resolve(staging, "state"), { mode: 0o700 });
      await rename(staging, directory);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  return {
    directory,
    conflicts() {
      using connection = openDatabase(database, true);
      const { db } = connection;
      return new Set(
        (tableExists(db, "nimbot_provider_reconnect")
          ? db.prepare("SELECT provider FROM nimbot_provider_reconnect").all()
          : []
        ).map(({ provider }) => provider as ProviderId),
      );
    },
    async purge(agentId: string) {
      if (!(await stat(database).catch(missing))) return;
      const workspacePath = agentProcessDirectories(state, agentId).workspace;
      const workspace =
        (await realpath(workspacePath).catch(missing)) ?? workspacePath;
      using connection = openDatabase(database);
      const { db } = connection;
      db.exec("PRAGMA busy_timeout = 5000");
      if (!tableExists(db, "session_v2")) return;
      const imported = tableExists(db, "nimbot_imported_session");
      transaction(db, () => {
        db.exec("CREATE TEMP TABLE purge_session (id TEXT PRIMARY KEY)");
        db.prepare(
          `
          INSERT INTO purge_session
          WITH RECURSIVE owned(id) AS (
            SELECT id FROM session_v2 WHERE directory = ? OR substr(directory, 1, length(?) + 1) = ? || '/'
            ${imported ? "UNION SELECT id FROM nimbot_imported_session WHERE agent_id = ?" : ""}
            UNION
            SELECT child.id FROM session_v2 child JOIN owned ON child.parent_id = owned.id
          ) SELECT id FROM owned
        `,
        ).run(workspace, workspace, workspace, ...(imported ? [agentId] : []));
        db.exec(`
          CREATE TEMP TABLE purge_blob AS SELECT DISTINCT hash FROM blob_ref WHERE session_id IN purge_session;
          CREATE TEMP TABLE purge_instruction AS
            SELECT json_each.value AS hash FROM instruction_state, json_each(initial_values)
              WHERE session_id IN purge_session
            UNION SELECT json_each.value FROM instruction_state, json_each(current_values)
              WHERE session_id IN purge_session
            UNION SELECT json_each.value FROM event, json_each(event.data, '$.delta')
              WHERE aggregate_id IN purge_session AND event.type LIKE 'session.instructions.updated%';
          DELETE FROM event_sequence WHERE aggregate_id IN purge_session;
          DELETE FROM job WHERE session_id IN purge_session OR child_session_id IN purge_session;
          DELETE FROM session_v2 WHERE id IN purge_session;
          DELETE FROM blob WHERE hash IN purge_blob AND hash NOT IN (SELECT hash FROM blob_ref);
          DELETE FROM instruction_blob WHERE hash IN purge_instruction AND hash NOT IN (
            SELECT json_each.value FROM instruction_state, json_each(initial_values)
            UNION SELECT json_each.value FROM instruction_state, json_each(current_values)
            UNION SELECT json_each.value FROM event, json_each(event.data, '$.delta')
              WHERE event.type LIKE 'session.instructions.updated%'
          );
          ${imported ? "DELETE FROM nimbot_imported_session WHERE id IN purge_session;" : ""}
        `);
      });
    },
  };
}
