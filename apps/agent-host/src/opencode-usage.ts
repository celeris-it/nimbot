import { z } from "zod";
import type {
  ModelReference,
  TaskUsage,
  UsageReading,
  UsageTokens,
} from "./engine-usage.js";
import type { OpenCodeRequest } from "./opencode-api.js";

const tokens = z
  .object({
    input: z.int().nonnegative(),
    output: z.int().nonnegative(),
    reasoning: z.int().nonnegative(),
    cache: z.object({
      read: z.int().nonnegative(),
      write: z.int().nonnegative(),
    }),
  })
  .transform((value) => ({
    input: value.input,
    output: value.output,
    reasoning: value.reasoning,
    cacheRead: value.cache.read,
    cacheWrite: value.cache.write,
  }));
const counter = z.object({
  id: z.string(),
  tokens,
  cost: z.number().nonnegative(),
});
const sessionResponse = z.object({ data: counter });
const childResponse = z.object({
  data: z.array(counter),
  cursor: z.object({ next: z.string().nullish() }).nullish(),
});
const maxSessions = 100;
const tokenFields = [
  "input",
  "output",
  "reasoning",
  "cacheRead",
  "cacheWrite",
] as const;

/** Read OpenCode's counters, including reused child sessions and native engine bookkeeping. */
export function createOpenCodeUsage(request: OpenCodeRequest) {
  async function read(
    session: string,
    model: ModelReference,
    priced: boolean,
  ): Promise<UsageReading> {
    const reading: UsageReading = {
      session,
      model,
      priced,
      complete: false,
      counters: [],
    };
    const deadline = Date.now() + 5_000;
    try {
      const root = sessionResponse.parse(
        await request(`/api/session/${encodeURIComponent(session)}`),
      ).data;
      reading.counters.push(root);
      const seen = new Set([root.id]);
      for (const parent of reading.counters) {
        let next: string | null | undefined;
        const cursors = new Set<string>();
        do {
          const remaining = deadline - Date.now();
          if (remaining <= 0 || seen.size >= maxSessions) return reading;
          const query = new URLSearchParams({
            parentID: parent.id,
            limit: "25",
          });
          if (next) query.set("cursor", next);
          const page = childResponse.parse(
            await request(`/api/session?${query}`, { timeout: remaining }),
          );
          for (const child of page.data) {
            if (seen.has(child.id) || seen.size === maxSessions) return reading;
            seen.add(child.id);
            reading.counters.push(child);
          }
          next = page.cursor?.next;
          if (next && cursors.has(next)) return reading;
          if (next) cursors.add(next);
        } while (next);
      }
      reading.complete = true;
    } catch {
      /* Keep successfully read counters and record incomplete coverage. */
    }
    return reading;
  }

  return {
    read,
    async finish(
      baseline: UsageReading,
      interrupted = false,
    ): Promise<TaskUsage> {
      const end = await read(baseline.session, baseline.model, baseline.priced);
      return measureUsage(baseline, end, interrupted);
    },
  };
}

export function measureUsage(
  start: UsageReading,
  end: UsageReading,
  interrupted = false,
): TaskUsage {
  const result: TaskUsage = {
    model: start.model,
    tokens: null,
    costUsd: null,
    state: "unavailable",
  };
  if (!start.counters.length || !end.counters.length) return result;
  const previous = new Map(start.counters.map((entry) => [entry.id, entry]));
  const delta: UsageTokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let known = 0;
  let cost = 0;
  let complete = start.complete && end.complete && !interrupted;
  for (const entry of end.counters) {
    const before = previous.get(entry.id);
    if (!before && !start.complete) continue;
    previous.delete(entry.id);
    const counterReset =
      (before?.cost ?? 0) > entry.cost ||
      tokenFields.some(
        (field) => (before?.tokens[field] ?? 0) > entry.tokens[field],
      );
    if (counterReset) {
      complete = false;
      continue;
    }
    known++;
    cost += entry.cost - (before?.cost ?? 0);
    for (const field of tokenFields)
      delta[field] += entry.tokens[field] - (before?.tokens[field] ?? 0);
  }
  if (!known) return result;
  result.tokens = delta;
  result.costUsd = cost > 0 || start.priced ? cost : null;
  result.state = complete && previous.size === 0 ? "reported" : "partial";
  return result;
}
