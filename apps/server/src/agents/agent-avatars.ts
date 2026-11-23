import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../logger.js";
import { agentProcessDirectories } from "../processes/agent-process-config.js";

const maxBytes = 256 * 1024;

function isJpeg(bytes: Buffer) {
  return (
    bytes.length >= 5 &&
    bytes.length <= maxBytes &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  );
}

async function download(agentId: string, request: typeof fetch) {
  const url = new URL("https://api.dicebear.com/10.x/bottts-neutral/jpg");
  url.search = new URLSearchParams({ seed: agentId, size: "256" }).toString();
  const response = await request(url, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (
    !response.ok ||
    response.headers.get("content-type")?.split(";")[0]?.trim() !==
      "image/jpeg" ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("Avatar response is not a JPEG");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Avatar exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  if (!isJpeg(bytes)) throw new Error("Avatar has an invalid JPEG signature");
  return bytes;
}

export function createAgentAvatars(
  dataDirectory: string,
  exists: (agentId: string) => boolean,
  request: typeof fetch = fetch,
) {
  const pending = new Map<string, Promise<Buffer | undefined>>();
  const purging = new Set<string>();

  async function load(agentId: string) {
    const { root } = agentProcessDirectories(dataDirectory, agentId);
    const path = join(root, "avatar.jpg");
    try {
      const saved = await readFile(path);
      if (isJpeg(saved)) return saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const bytes = await download(agentId, request);
    if (purging.has(agentId)) return;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = join(root, `.avatar-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return bytes;
  }

  return {
    get(agentId: string): Promise<Buffer | undefined> {
      if (purging.has(agentId) || !exists(agentId))
        return Promise.resolve(undefined);
      const current = pending.get(agentId);
      if (current) return current;
      const operation = load(agentId)
        .catch(() => {
          log.warn("avatar.load_failed", { agentId });
          return undefined;
        })
        .finally(() => pending.delete(agentId));
      pending.set(agentId, operation);
      return operation;
    },
    async withPurge(agentId: string, remove: () => Promise<void>) {
      if (purging.has(agentId))
        throw new Error("Agent purge already in progress");
      purging.add(agentId);
      try {
        await pending.get(agentId);
        await remove();
      } finally {
        purging.delete(agentId);
      }
    },
  };
}
