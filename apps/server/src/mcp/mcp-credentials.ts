import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { McpCatalog } from "./mcp-catalog.js";

const MAX_TOKEN_LENGTH = 4096;
export const isMcpBearer = (token: string) =>
  token.length <= MAX_TOKEN_LENGTH && /^[\x21-\x7e]+$/.test(token);
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

/** SQLite holds opaque references. Bearer values live only in this directory. */
export async function openMcpCredentials(
  catalog: McpCatalog,
  directory: string,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.mode & 0o077)
    throw new Error("MCP credential directory must be private.");

  function path(reference: string) {
    if (!/^mcp-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(reference))
      throw new Error("Invalid MCP credential reference.");
    return join(directory, reference);
  }

  async function erase(reference: string) {
    try {
      await unlink(path(reference));
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  async function save(token: string): Promise<string> {
    const reference = `mcp-${randomUUID()}`;
    const file = await open(path(reference), "wx", 0o600);
    try {
      try {
        await file.writeFile(token);
      } finally {
        await file.close();
      }
    } catch (error) {
      await erase(reference);
      throw error;
    }
    return reference;
  }

  async function cleanup() {
    for (const reference of catalog.retiredCredentials()) {
      try {
        await erase(reference);
        catalog.forgetRetiredCredential(reference);
      } catch {
        // Keep the durable reference so a later cleanup can retry.
      }
    }
    return { cleanupPending: catalog.hasRetiredCredentials() };
  }

  return {
    cleanup,
    async set(definitionId: string, revision: number, token: string | null) {
      if (catalog.credentialBinding(definitionId)?.revision !== revision)
        return undefined;
      if (token !== null && !isMcpBearer(token))
        throw new Error("Invalid MCP bearer credential.");

      const reference = token === null ? null : await save(token);
      let committed = false;
      try {
        committed = catalog.replaceCredential(
          definitionId,
          revision,
          reference,
        );
      } finally {
        if (!committed && reference !== null) await erase(reference);
      }
      if (!committed) return undefined;
      return cleanup();
    },
    async read(
      definitionId: string,
      revision: number,
    ): Promise<string | undefined> {
      const before = catalog.credentialBinding(definitionId);
      if (!before?.reference || before.revision !== revision) return undefined;
      const filename = path(before.reference);
      try {
        const info = await lstat(filename);
        if (!info.isFile() || info.mode & 0o077 || info.size > MAX_TOKEN_LENGTH)
          throw new Error("MCP credential file is invalid.");
        const token = await readFile(filename, "utf8");
        const after = catalog.credentialBinding(definitionId);
        if (
          after?.revision !== revision ||
          after.reference !== before.reference
        )
          return undefined;
        if (!isMcpBearer(token))
          throw new Error("MCP credential file is invalid.");
        return token;
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    },
  };
}

export type McpCredentials = Awaited<ReturnType<typeof openMcpCredentials>>;
