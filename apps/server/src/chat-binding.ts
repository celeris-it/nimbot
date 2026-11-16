import { DatabaseSync } from "node:sqlite";

export interface ChatBinding {
  get(botId: number): number | undefined;
  save(botId: number, chatId: number): void;
}

/** Identities only; shared with the agent registry, which creates the same table. */
export const CHAT_BINDINGS_SCHEMA = `CREATE TABLE IF NOT EXISTS chat_bindings (
  agent_id TEXT PRIMARY KEY,
  bot_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL
);`;

/** Store identities only. Bot tokens never enter this database. */
export function openChatBinding(
  path: string,
  agent: { id: string; ownerId: number },
): ChatBinding & { close(): void } {
  const db = new DatabaseSync(path);
  try {
    db.exec(CHAT_BINDINGS_SCHEMA);
  } catch (error) {
    db.close();
    throw error;
  }
  const select = db.prepare(
    "SELECT chat_id FROM chat_bindings WHERE agent_id = ? AND bot_id = ? AND owner_id = ?",
  );
  const save = db.prepare(
    "INSERT INTO chat_bindings (agent_id, bot_id, owner_id, chat_id) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET bot_id = excluded.bot_id, owner_id = excluded.owner_id, chat_id = excluded.chat_id",
  );
  return {
    get(botId) {
      const row = select.get(agent.id, botId, agent.ownerId);
      return row ? Number(row.chat_id) : undefined;
    },
    save(botId, chatId) {
      save.run(agent.id, botId, agent.ownerId, chatId);
    },
    close() {
      db.close();
    },
  };
}
