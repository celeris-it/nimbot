import { URL } from "node:url";
import { readFileSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const serverV2 = readFileSync(
  new URL("./state-schema/server-v2.sql", import.meta.url),
  "utf8",
);
const serverProcessV2 = readFileSync(
  new URL("./state-schema/server-process-v2.sql", import.meta.url),
  "utf8",
);
const serverProcessV3 = readFileSync(
  new URL("./state-schema/server-process-v3.sql", import.meta.url),
  "utf8",
);
export const taskExecutionSchema = readFileSync(
  new URL("./state-schema/server-process-v4.sql", import.meta.url),
  "utf8",
);
const serverProcessV5 = readFileSync(
  new URL("./state-schema/server-process-v5.sql", import.meta.url),
  "utf8",
);
const serverProcessV6 = readFileSync(
  new URL("./state-schema/server-process-v6.sql", import.meta.url),
  "utf8",
);
const mcpToolSetup = readFileSync(
  new URL("./state-schema/mcp-tool-setup.sql", import.meta.url),
  "utf8",
);
const mcpSharedCredentials = readFileSync(
  new URL("./state-schema/mcp-shared-credentials.sql", import.meta.url),
  "utf8",
);
const mcpLocal = readFileSync(
  new URL("./state-schema/mcp-local.sql", import.meta.url),
  "utf8",
);
function migrateReferencedTable(db, sql) {
  db.exec(sql);
  if (db.prepare("PRAGMA foreign_key_check").get())
    throw new Error("Server schema migration produced invalid references.");
}
const definitions = {
  "server-process": {
    version: 9,
    applicationId: 0x4e494d50,
    get current() {
      return [
        baseline("server-process"),
        serverProcessV2,
        serverProcessV3,
        taskExecutionSchema,
        serverProcessV5,
        serverProcessV6,
        mcpToolSetup,
        mcpSharedCredentials,
        mcpLocal,
      ].join("\n");
    },
    migrations: {
      2(db) {
        migrateReferencedTable(db, serverProcessV2);
      },
      3(db) {
        migrateReferencedTable(db, serverProcessV3);
      },
      4(db) {
        db.exec(taskExecutionSchema);
      },
      5(db) {
        db.exec(serverProcessV5);
      },
      6(db) {
        db.exec(serverProcessV6);
      },
      7(db) {
        db.exec(mcpToolSetup);
      },
      8(db) {
        db.exec(mcpSharedCredentials);
      },
      9(db) {
        db.exec(mcpLocal);
      },
    },
  },
  server: {
    version: 3,
    get current() {
      return [baseline("server"), serverV2, mcpToolSetup].join("\n");
    },
    migrations: {
      2(db) {
        migrateReferencedTable(db, serverV2);
      },
      3(db) {
        db.exec(mcpToolSetup);
      },
    },
  },
  tasks: { version: 1, migrations: {} },
  memory: { version: 1, migrations: {} },
};

function schema(db) {
  return db
    .prepare(
      `SELECT type, name, sql FROM sqlite_schema
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      AND name NOT IN (SELECT name FROM pragma_table_list WHERE type = 'shadow')
      ORDER BY type, name`,
    )
    .all()
    .map(({ type, name, sql }) => [type, name, sql.trim()]);
}

function baseline(kind) {
  return readFileSync(
    new URL(`./state-schema/${kind}-v1.sql`, import.meta.url),
    "utf8",
  );
}

function transaction(db, run) {
  db.exec("BEGIN IMMEDIATE");
  try {
    run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function initialize(db, kind, definition, options) {
  const actual = schema(db);
  if (actual.length === 0 && !options.existing) {
    if (definition.version > 1 && !definition.current)
      throw new Error("Missing current schema for fresh installations.");
    db.exec(definition.current ?? baseline(kind));
    return definition.version;
  }
  if (options.legacy === false)
    throw new Error(
      "An unversioned database is outside the supported upgrade path.",
    );
  const reference = new DatabaseSync(":memory:");
  try {
    reference.exec(baseline(kind));
    if (JSON.stringify(actual) !== JSON.stringify(schema(reference)))
      throw new Error(
        "Schema differs from the supported unversioned baseline.",
      );
    return 1;
  } finally {
    reference.close();
  }
}

export function prepareStateSchema(path, kind, options = {}) {
  const definition = options.definition ?? definitions[kind];
  if (!definition || !Object.hasOwn(definitions, kind))
    throw new Error("Unknown SQLite store.");
  let db;
  const rebuildsReferencedTable =
    definition === definitions.server ||
    definition === definitions["server-process"];
  try {
    if (typeof path === "string") {
      const file = lstatSync(path, { throwIfNoEntry: false });
      if (file && !file.isFile()) throw new Error("Expected a regular file.");
      if (!file && options.existing) throw new Error("Database is missing.");
      db = new DatabaseSync(path);
    } else db = path;
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
    const { application_id: applicationId } = db
      .prepare("PRAGMA application_id")
      .get();
    const processApplicationId = definitions["server-process"].applicationId;
    if (kind === "server-process") {
      if (
        applicationId !== processApplicationId &&
        (applicationId !== 0 || schema(db).length > 0)
      )
        throw new Error(
          "A fresh subprocess installation is required. Existing data was retained; select a new data directory.",
        );
    } else if (kind === "server" && applicationId === processApplicationId) {
      throw new Error(
        "Subprocess Server state cannot be opened by the per-agent Docker runtime.",
      );
    }
    // These migrations rebuild referenced tables. SQLite requires
    // disabling enforcement outside the transaction and checking before commit.
    if (rebuildsReferencedTable) db.exec("PRAGMA foreign_keys = OFF");
    let current = false;
    while (!current) {
      transaction(db, () => {
        if (kind === "server-process")
          db.exec(`PRAGMA application_id = ${processApplicationId}`);
        const { user_version: installed } = db
          .prepare("PRAGMA user_version")
          .get();
        if (installed < 0 || installed > definition.version)
          throw new Error(`Unsupported schema version ${installed}.`);
        if (installed === definition.version) {
          current = true;
          return;
        }
        let next;
        if (installed === 0) {
          next = initialize(db, kind, definition, options);
        } else {
          next = installed + 1;
          const migrate = definition.migrations[next];
          if (!migrate)
            throw new Error(`Missing migration for schema version ${next}.`);
          migrate(db);
        }
        db.exec(`PRAGMA user_version = ${next}`);
        current = next === definition.version;
      });
    }
  } catch (error) {
    throw new Error(`${kind}.sqlite: ${error.message}`, { cause: error });
  } finally {
    if (typeof path === "string") db?.close();
    else if (rebuildsReferencedTable) db?.exec("PRAGMA foreign_keys = ON");
  }
}
