import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
/** Private token files; runtime endpoints are supplied by the process manager. */
export async function openHostTokenFiles(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.mode & 0o077)
    throw new Error("Host credential directory must be private");
  const path = (ref: string) => {
    if (!/^file:host-[a-f0-9-]{36}$/.test(ref))
      throw new Error("Invalid Host credential reference");
    return join(directory, ref.slice(5));
  };
  async function read(ref: string) {
    const info = await lstat(path(ref));
    if (!info.isFile() || info.mode & 0o077)
      throw new Error("Host credential file must be private");
    const token = await readFile(path(ref), "utf8");
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new Error("Invalid Host credential");
    return token;
  }
  return {
    read,
    /** Erases a credential file after its registry reference was dropped. */
    async remove(ref: string) {
      try {
        await unlink(path(ref));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
    async create() {
      const ref = `file:host-${randomUUID()}`;
      const token = randomBytes(32).toString("hex");
      await writeFile(path(ref), token, { mode: 0o600, flag: "wx" });
      return { ref, token };
    },
  };
}
