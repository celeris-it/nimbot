import { DatabaseSync } from "node:sqlite";

export function parseAllowedUsers(text: string): Set<number> {
  const ids = text.trim() ? text.trim().split(/[\s,]+/) : [];
  if (
    ids.some(
      (id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)),
    )
  )
    throw new Error(
      "Enter positive numeric Telegram user IDs separated by commas or spaces.",
    );
  return new Set(ids.map(Number));
}

/** One shared live set: all bot handlers and admission checks see committed changes. */
export function openTelegramAccess(
  path: string,
  initial: ReadonlySet<number> = new Set(),
) {
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE IF NOT EXISTS telegram_access (id INTEGER PRIMARY KEY CHECK(id = 1), user_ids TEXT NOT NULL)",
  );
  db.prepare(
    "INSERT OR IGNORE INTO telegram_access(id, user_ids) VALUES (1, ?)",
  ).run([...initial].join(","));
  const row = db
    .prepare("SELECT user_ids FROM telegram_access WHERE id = 1")
    .get()!;
  const users = parseAllowedUsers(String(row.user_ids));
  return {
    users: users as ReadonlySet<number>,
    save(text: string) {
      const next = parseAllowedUsers(text);
      db.prepare("UPDATE telegram_access SET user_ids = ? WHERE id = 1").run(
        [...next].join(","),
      );
      users.clear();
      for (const id of next) users.add(id);
    },
    close: () => db.close(),
  };
}
