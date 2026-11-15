import { expect, it } from "vitest";
import { createLogger, redact } from "./logger.js";

function capture() {
  const lines: { level: string; entry: Record<string, unknown> }[] = [];
  const logger = createLogger(
    (level, line) => lines.push({ level, entry: JSON.parse(line) }),
    {},
    () => new Date("2026-01-02T03:04:05.000Z"),
  );
  return { lines, logger };
}

it("writes one JSON entry with time, level, event, and the agent and task IDs", () => {
  const { lines, logger } = capture();
  logger.child({ agentId: "developer" }).info("task.started", { taskId: "t1" });
  expect(lines).toEqual([
    {
      level: "info",
      entry: {
        time: "2026-01-02T03:04:05.000Z",
        level: "info",
        event: "task.started",
        agentId: "developer",
        taskId: "t1",
      },
    },
  ]);
});

it("removes Telegram tokens, bearer credentials, Host tokens, and secret-named fields", () => {
  const { lines, logger } = capture();
  const telegram = "123456789:AAH-abcdefghijklmnopqrstuvwxyz_0123";
  const host = "a".repeat(64);
  logger.error(`failed with ${telegram}`, {
    detail: `Authorization: Bearer ${host} and ${telegram}`,
    botToken: "plain",
    password: "hunter2",
    agentId: "x",
  });
  const text = JSON.stringify(lines);
  for (const secret of [telegram, host, "plain", "hunter2"])
    expect(text).not.toContain(secret);
  expect(lines[0]!.entry).toMatchObject({
    botToken: "[redacted]",
    password: "[redacted]",
    agentId: "x",
  });
  expect(redact(`hash scrypt:${"ab".repeat(16)}:${"cd".repeat(64)}`)).toBe(
    "hash [redacted]",
  );
});

it("routes levels to the sink and bounds long values", () => {
  const { lines, logger } = capture();
  logger.warn("w", { long: "x".repeat(2000) });
  expect(lines[0]!.level).toBe("warn");
  expect(String(lines[0]!.entry.long)).toHaveLength(500);
});
