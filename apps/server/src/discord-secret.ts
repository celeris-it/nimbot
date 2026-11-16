import { mkdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Server-only secret files. Store only their opaque references in SQLite. */
export async function openDiscordSecrets(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await stat(directory);
  if (info.mode & 0o077)
    throw new Error("Discord secret directory must be private");
  const path = (ref: string) => {
    if (!/^file:discord-[a-f0-9-]{36}$/.test(ref))
      throw new Error("Invalid credential reference");
    return join(directory, ref.slice(5));
  };
  return {
    async save(token: string) {
      const ref = `file:discord-${randomUUID()}`;
      await writeFile(path(ref), token, { mode: 0o600, flag: "wx" });
      return ref;
    },
    async read(ref: string) {
      if ((await stat(path(ref))).mode & 0o077)
        throw new Error("Discord secret file must be private");
      return readFile(path(ref), "utf8");
    },
    async remove(ref: string) {
      await unlink(path(ref));
    },
  };
}
