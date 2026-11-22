import type { AgentHostConfig } from "./host/agent-host.js";

export class HostMemoryError extends Error {
  constructor(readonly status: 400 | 404 | 503) {
    super("Memory request failed");
  }
}

export interface MemoryEntry {
  id: string;
  title: string;
  preview: string;
  tags: string[];
  updatedAt: number;
  expiresAt: number | null;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Fixed authenticated operations on one registered agent. The Host's reply is untrusted. */
export function createHostMemories(
  resolve: (id: string) => Promise<AgentHostConfig>,
  request: typeof fetch = fetch,
) {
  async function call(id: string, path: string, post: boolean) {
    try {
      const host = await resolve(id);
      const response = await request(`${host.url}${path}`, {
        method: post ? "POST" : "GET",
        headers: { Authorization: `Bearer ${host.token}` },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok)
        throw new HostMemoryError(
          response.status === 404 ? 404 : response.status === 400 ? 400 : 503,
        );
      const text = await response.text();
      if (text.length > 400_000) throw new HostMemoryError(503);
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw error instanceof HostMemoryError ? error : new HostMemoryError(503);
    }
  }
  return {
    async list(
      id: string,
      page: number,
    ): Promise<{ memories: MemoryEntry[]; hasMore: boolean }> {
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000)
        throw new HostMemoryError(400);
      const data = (await call(id, `/memories?page=${page}`, false)) as Record<
        string,
        unknown
      > | null;
      if (!data || !Array.isArray(data.memories) || data.memories.length > 50)
        throw new HostMemoryError(503);
      const memories: MemoryEntry[] = [];
      for (const item of data.memories as Record<string, unknown>[]) {
        // Skip anything malformed instead of failing the whole view.
        if (
          item &&
          typeof item.id === "string" &&
          UUID.test(item.id) &&
          typeof item.title === "string" &&
          typeof item.content === "string" &&
          Array.isArray(item.tags) &&
          Number.isSafeInteger(item.updatedAt)
        )
          memories.push({
            id: item.id,
            title: item.title.slice(0, 120),
            preview: item.content.slice(0, 200),
            tags: item.tags
              .filter((tag): tag is string => typeof tag === "string")
              .slice(0, 10)
              .map((tag) => tag.slice(0, 32)),
            updatedAt: item.updatedAt as number,
            expiresAt: Number.isSafeInteger(item.expiresAt)
              ? (item.expiresAt as number)
              : null,
          });
      }
      return { memories, hasMore: data.hasMore === true };
    },
    async remove(id: string, memoryId: string): Promise<void> {
      if (!UUID.test(memoryId)) throw new HostMemoryError(400);
      await call(id, `/memories/${memoryId}/delete`, true);
    },
  };
}
