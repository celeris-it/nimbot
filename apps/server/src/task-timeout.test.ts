import { expect, it } from "vitest";
import { readTaskTimeoutSeconds, taskWaitMs } from "./task-timeout.js";
import { readProvisioningConfig } from "./agent-provisioning.js";

it("defaults to ten minutes, validates the setting, and waits slightly longer than the Host", () => {
  expect(readTaskTimeoutSeconds({})).toBe(600);
  expect(readTaskTimeoutSeconds({ TASK_TIMEOUT_SECONDS: "90" })).toBe(90);
  for (const bad of ["9", "3601", "1e2", "abc", "1.5"])
    expect(() => readTaskTimeoutSeconds({ TASK_TIMEOUT_SECONDS: bad })).toThrow(
      "TASK_TIMEOUT_SECONDS",
    );
  expect(taskWaitMs(90)).toBe(120_000);
});

it("hands the validated timeout to provisioned Agent Hosts", () => {
  const env = {
    AGENT_HOST_IMAGE: `sha256:${"a".repeat(64)}`,
    SERVER_CONTAINER_NAME: "nimbot-server",
    DOCKER_SOCKET_PATH: "/var/run/docker.sock",
  };
  expect(readProvisioningConfig(env)?.taskTimeoutSeconds).toBe(600);
  expect(
    readProvisioningConfig({ ...env, TASK_TIMEOUT_SECONDS: "45" })
      ?.taskTimeoutSeconds,
  ).toBe(45);
  expect(() =>
    readProvisioningConfig({ ...env, TASK_TIMEOUT_SECONDS: "5" }),
  ).toThrow();
});
