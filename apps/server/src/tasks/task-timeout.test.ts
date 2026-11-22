import { expect, it } from "vitest";
import { readTaskTimeoutSeconds, taskWaitMs } from "./task-timeout.js";

it("defaults to ten minutes, validates the setting, and waits slightly longer than the Host", () => {
  expect(readTaskTimeoutSeconds({})).toBe(600);
  expect(readTaskTimeoutSeconds({ TASK_TIMEOUT_SECONDS: "90" })).toBe(90);
  for (const bad of ["9", "3601", "1e2", "abc", "1.5"])
    expect(() => readTaskTimeoutSeconds({ TASK_TIMEOUT_SECONDS: bad })).toThrow(
      "TASK_TIMEOUT_SECONDS",
    );
  expect(taskWaitMs(90)).toBe(120_000);
});
