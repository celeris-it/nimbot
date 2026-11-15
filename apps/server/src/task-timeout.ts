/** Same setting as the Agent Host's: TASK_TIMEOUT_SECONDS (10–3600, default 600). */
export function readTaskTimeoutSeconds(env: NodeJS.ProcessEnv): number {
  const text = env.TASK_TIMEOUT_SECONDS?.trim();
  if (!text) return 600;
  const seconds = Number(text);
  if (!/^\d+$/.test(text) || seconds < 10 || seconds > 3600)
    throw new Error("TASK_TIMEOUT_SECONDS must be between 10 and 3600.");
  return seconds;
}

/** The server waits slightly longer than the Host's own limit, as a backstop only. */
export function taskWaitMs(timeoutSeconds: number): number {
  return (timeoutSeconds + 30) * 1000;
}
