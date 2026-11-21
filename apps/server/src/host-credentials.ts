import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { openAgentRegistry } from "./agent-registry.js";

/** Tokens remain in private server files; only opaque references enter SQLite. */
export async function openHostCredentials(
  directory: string,
  registry: Pick<
    ReturnType<typeof openAgentRegistry>,
    "getHostCredentialRef" | "setHostCredentialRef" | "getProvisioning"
  >,
) {
  const files = await openHostTokenFiles(directory);
  function url(agentId: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(agentId))
      throw new Error("Invalid agent ID");
    return `http://nimbot-${agentId}:3001`;
  }
  async function read(agentId: string) {
    const origin = url(agentId);
    const ref = registry.getHostCredentialRef(agentId);
    if (!ref) throw new Error("Host credential is missing");
    return { url: origin, token: await files.read(ref) };
  }
  return {
    read,
    remove: files.remove,
    /** Called only while the registry's provisioning transition holds the per-agent lock. */
    async prepare(agentId: string) {
      const origin = url(agentId);
      if (registry.getProvisioning(agentId)?.status !== "provisioning")
        throw new Error("Agent is not provisioning");
      // Never rotate a missing/unreadable saved token: an existing container may use it.
      if (registry.getHostCredentialRef(agentId)) return read(agentId);
      const { ref, token } = await files.create();
      try {
        registry.setHostCredentialRef(agentId, ref);
      } catch (error) {
        await files.remove(ref);
        throw error;
      }
      return { url: origin, token };
    },
  };
}

/** Shared private token files for the transitional Docker and subprocess runtimes. */
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
