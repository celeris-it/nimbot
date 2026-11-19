import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { prepareStateSchema } from "./state-schema.mjs";

const [command, ...args] = process.argv.slice(2);
const state = "/state";

try {
  switch (command) {
    case "schema": {
      const [kind, source] = args;
      const path = `${state}/${kind}.sqlite`;
      // Retained/deleted and never-started Hosts can have an empty task volume.
      if (kind === "server" || lstatSync(path, { throwIfNoEntry: false }))
        prepareStateSchema(path, kind, {
          existing: true,
          legacy: source === "legacy-main",
        });
      break;
    }
    case "agents": {
      const db = new DatabaseSync(`${state}/server.sqlite`, { readOnly: true });
      try {
        const pending = db
          .prepare(
            `SELECT id FROM agents a WHERE deleted_at IS NULL AND (
              EXISTS (SELECT 1 FROM container_operations WHERE agent_id = a.id AND status = 'pending')
              OR EXISTS (SELECT 1 FROM agent_provisioning WHERE agent_id = a.id AND status = 'provisioning')
              OR EXISTS (SELECT 1 FROM agent_recovery WHERE agent_id = a.id AND status IN ('recovering', 'interrupted', 'failed'))
            )`,
          )
          .all();
        if (pending.length)
          throw new Error(
            "Resolve pending container operations or incomplete recovery before upgrading.",
          );
        process.stdout.write(
          JSON.stringify(
            db
              .prepare(
                `
          SELECT a.id, a.container_ref AS container, p.network_ref AS network,
                 p.volume_ref AS workspace, h.credential_ref AS credential
          FROM agents a LEFT JOIN agent_provisioning p ON p.agent_id = a.id
          LEFT JOIN agent_host_credentials h ON h.agent_id = a.id WHERE a.deleted_at IS NULL
        `,
              )
              .all(),
          ),
        );
      } finally {
        db.close();
      }
      break;
    }
    case "replace": {
      const db = new DatabaseSync(`${state}/server.sqlite`);
      try {
        const replacements = JSON.parse(readFileSync(0, "utf8"));
        db.exec("BEGIN IMMEDIATE");
        const replace = db.prepare(
          "UPDATE agents SET container_ref = ? WHERE id = ? AND container_ref = ?",
        );
        for (const { id, before, after } of replacements) {
          if (replace.run(after, id, before).changes !== 1)
            throw new Error(`Agent ${id} changed during upgrade.`);
        }
        db.exec("COMMIT");
      } finally {
        db.close();
      }
      break;
    }
    case "token": {
      const [ref] = args;
      if (!/^file:host-[a-f0-9-]{36}$/.test(ref))
        throw new Error("Missing or invalid saved Host credential reference.");
      const path = `${state}/host-secrets/${ref.slice(5)}`;
      const file = lstatSync(path);
      if (!file.isFile() || file.mode & 0o077)
        throw new Error("Invalid saved Host credential file.");
      const token = readFileSync(path, "utf8");
      if (!/^[a-f0-9]{64}$/.test(token))
        throw new Error("Invalid saved Host credential.");
      process.stdout.write(token);
      break;
    }
    case "activate": {
      const [token] = args;
      const path = `${state}/.upgrade-activation`;
      writeFileSync(`${path}.tmp`, token, { mode: 0o600, flush: true });
      renameSync(`${path}.tmp`, path);
      const directory = openSync(state, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      break;
    }
    default:
      throw new Error("Unknown state upgrade command.");
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
