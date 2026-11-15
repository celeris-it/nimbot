import { setTimeout as delay } from "node:timers/promises";
import { GrammyError } from "grammy";

/** Waits between the attempts that follow the first one; its length bounds the retries. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 1500];

/** Telegram answered and said no: repeating the request cannot help. */
export function isDefinitiveTelegramRejection(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.error_code >= 400 &&
    error.error_code < 500 &&
    error.error_code !== 429
  );
}

/**
 * Repeats a read-only operation after transient failures, a bounded number of times.
 * Cancellation and definitive rejections (such as a revoked token) are never retried.
 */
export async function retryTransient<T>(
  attempt: () => Promise<T>,
  signal: AbortSignal,
  delaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
  sleep: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, s) =>
    delay(ms, undefined, { signal: s }),
): Promise<T> {
  for (let failures = 0; ; failures++) {
    try {
      return await attempt();
    } catch (error) {
      const wait = delaysMs[failures];
      if (
        wait === undefined ||
        signal.aborted ||
        isDefinitiveTelegramRejection(error)
      )
        throw error;
      try {
        await sleep(wait, signal);
      } catch {
        throw error;
      }
    }
  }
}
