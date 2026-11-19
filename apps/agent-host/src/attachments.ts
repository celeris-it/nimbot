import { constants } from "node:fs";
import { link, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { BridgeTool } from "./tool-bridge.js";

export const ATTACHMENT_LIMIT = 10 * 1024 * 1024;
export const ATTACHMENT_OPERATION = "workspace.attach_file";
export const attachmentTaskId =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const filename = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/;

function directory(handle: FileHandle) {
  // Pin each directory in the Linux container while opening its children.
  return `/proc/self/fd/${handle.fd}`;
}

export function createAttachments(workspace: string) {
  type Snapshot = {
    hostTaskId: string;
    name: string;
    bytes?: Buffer;
    timer: NodeJS.Timeout;
  };
  let snapshot: Snapshot | undefined;
  function discard(hostTaskId: string) {
    if (snapshot?.hostTaskId !== hostTaskId) return;
    clearTimeout(snapshot.timer);
    snapshot = undefined;
  }

  async function within<T>(
    folder: "attachments" | "exports",
    taskId: string,
    create: boolean,
    work: (path: string) => Promise<T>,
  ) {
    if (!attachmentTaskId.test(taskId)) throw new Error("Invalid task ID");
    const flags =
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    const root = await open(workspace, flags);
    try {
      const basePath = directory(root) + "/" + folder;
      if (create) await mkdir(basePath, { recursive: true });
      const base = await open(basePath, flags);
      try {
        const taskPath = directory(base) + "/" + taskId;
        if (create) await mkdir(taskPath, { recursive: true });
        const task = await open(taskPath, flags);
        try {
          return await work(directory(task));
        } finally {
          await task.close();
        }
      } finally {
        await base.close();
      }
    } finally {
      await root.close();
    }
  }

  const tool: BridgeTool = {
    operation: ATTACHMENT_OPERATION,
    name: "attach_file",
    description:
      "When the owner explicitly asks for a file, stage one file from this task's exports directory to return to the same chat after successful completion.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", pattern: filename.source } },
      required: ["name"],
      additionalProperties: false,
    },
    async invoke(args, { context, signal }) {
      const { name } = args;
      if (
        typeof name !== "string" ||
        !filename.test(name) ||
        Object.keys(args).length !== 1
      )
        throw new Error("Invalid file name");
      const bytes = await within(
        "exports",
        context.identity.serverTaskId,
        false,
        async (path) => {
          const file = await open(
            path + "/" + name,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const stat = await file.stat();
            if (
              !stat.isFile() ||
              stat.nlink !== 1 ||
              stat.size > ATTACHMENT_LIMIT
            )
              throw new Error("Invalid export file");
            const buffer = Buffer.alloc(stat.size + 1);
            let length = 0;
            while (length < buffer.length) {
              signal.throwIfAborted();
              const { bytesRead } = await file.read(
                buffer,
                length,
                buffer.length - length,
                length,
              );
              if (!bytesRead) break;
              length += bytesRead;
            }
            if (length !== stat.size)
              throw new Error("Export file changed while reading");
            return buffer.subarray(0, length);
          } finally {
            await file.close();
          }
        },
      );
      signal.throwIfAborted();
      if (snapshot?.hostTaskId === context.hostTaskId)
        throw new Error("A document has already been selected");
      if (snapshot) discard(snapshot.hostTaskId);
      const timer = setTimeout(() => {
        if (snapshot?.hostTaskId === context.hostTaskId)
          snapshot.bytes = undefined;
      }, 600_000);
      timer.unref();
      snapshot = { hostTaskId: context.hostTaskId, name, bytes, timer };
      return { staged: name, size: bytes.length };
    },
  };

  return {
    tool,
    discard,
    has: (hostTaskId: string) => snapshot?.hostTaskId === hostTaskId,
    consume(hostTaskId: string) {
      if (snapshot?.hostTaskId !== hostTaskId) return undefined;
      const { name, bytes } = snapshot;
      discard(hostTaskId);
      return bytes ? { name, bytes } : undefined;
    },
    async importFile(
      taskId: string,
      name: string,
      body: ReadableStream<Uint8Array>,
      expected: number,
      signal: AbortSignal,
    ) {
      if (
        !filename.test(name) ||
        !Number.isSafeInteger(expected) ||
        expected < 0 ||
        expected > ATTACHMENT_LIMIT
      )
        throw new Error("Invalid attachment metadata");
      await within("attachments", taskId, true, async (path) => {
        const temp = path + "/" + randomUUID() + ".part";
        const reader = body.getReader();
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          const file = await open(temp, "wx", 0o600);
          try {
            let length = 0;
            while (true) {
              signal.throwIfAborted();
              const { value, done } = await reader.read();
              if (done) break;
              length += value.length;
              if (length > expected) throw new Error("Attachment too large");
              await file.writeFile(value);
            }
            if (length !== expected) throw new Error("Incomplete attachment");
            await file.sync();
          } finally {
            await file.close();
          }
          signal.throwIfAborted();
          await link(temp, path + "/" + name);
        } finally {
          signal.removeEventListener("abort", cancel);
          cancel();
          await unlink(temp).catch(() => {});
        }
      });
    },
  };
}
