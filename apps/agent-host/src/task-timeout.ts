/** Maximum run time of one task, from TASK_TIMEOUT_SECONDS (10–3600, default 600). */
export function readTaskTimeoutMs(env: NodeJS.ProcessEnv): number {
  const text = env.TASK_TIMEOUT_SECONDS?.trim();
  if (!text) return 600_000;
  const seconds = Number(text);
  if (!/^\d+$/.test(text) || seconds < 10 || seconds > 3600)
    throw new Error("TASK_TIMEOUT_SECONDS must be between 10 and 3600.");
  return seconds * 1000;
}
