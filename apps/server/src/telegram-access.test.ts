import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openTelegramAccess, parseAllowedUsers } from "./telegram-access.js";

it("starts empty, applies committed changes to the live set and preserves them across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbot-access-"));
  const path = join(dir, "state.sqlite");
  let access = openTelegramAccess(path);
  try {
    const live = access.users;
    expect([...live]).toEqual([]);
    access.save("42, 73\n42");
    expect([...live]).toEqual([42, 73]);
    expect(() => access.save("42, bad")).toThrow();
    expect([...live]).toEqual([42, 73]);
    access.close();
    access = openTelegramAccess(path, new Set([99]));
    expect([...access.users]).toEqual([42, 73]);
    access.save("");
    access.close();
    access = openTelegramAccess(path, new Set([99]));
    expect([...access.users]).toEqual([]);
  } finally {
    access.close();
    rmSync(dir, { recursive: true });
  }
});
it.each(["0", "-1", "42.0", "1e2", "9007199254740992"])(
  "rejects invalid Telegram ID %s",
  (id) => {
    expect(() => parseAllowedUsers(id)).toThrow();
  },
);
