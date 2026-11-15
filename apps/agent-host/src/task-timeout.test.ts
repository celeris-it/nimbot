import { expect, it } from "vitest";
import { readTaskTimeoutMs } from "./task-timeout.js";

it("defaults to ten minutes and validates TASK_TIMEOUT_SECONDS", () => {
  expect(readTaskTimeoutMs({})).toBe(600_000);
  expect(readTaskTimeoutMs({ TASK_TIMEOUT_SECONDS: " 90 " })).toBe(90_000);
  for (const bad of ["9", "3601", "1e2", "-5", "abc", "1.5"])
    expect(() => readTaskTimeoutMs({ TASK_TIMEOUT_SECONDS: bad })).toThrow(
      "TASK_TIMEOUT_SECONDS",
    );
});
