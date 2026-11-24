import { expect, it, vi } from "vitest";
import { withAgentInstructions } from "./agent-instructions.js";

it("snapshots shared and agent instructions each time a task is dispatched", async () => {
  let sharedRules = "First defaults";
  let agentRules = "First instructions";
  const execute = vi.fn().mockResolvedValue("done");
  const run = withAgentInstructions(execute, () => ({
    sharedRules,
    instructions: "",
    agentRules,
  }));
  const first = run("first task");
  sharedRules = "New defaults";
  agentRules = "New instructions";
  await first;
  await run("second task");

  expect(execute.mock.calls[0]?.[0]).toBe("first task");
  expect(execute.mock.calls[0]?.[5]).toEqual({
    sharedRules: "First defaults",
    instructions: "",
    agentRules: "First instructions",
  });
  expect(execute.mock.calls[1]?.[5]).toEqual({
    sharedRules: "New defaults",
    instructions: "",
    agentRules: "New instructions",
  });
});

it("forwards the execution identity and acceptance hook", async () => {
  const execute = vi.fn().mockResolvedValue("done");
  const execution = {
    identity: { agentId: "a", serverTaskId: "server-task" },
    onAccepted: vi.fn(() => true),
  };
  await withAgentInstructions(execute, () => ({
    sharedRules: "",
    instructions: "",
    agentRules: "Follow owner instructions",
  }))("task", undefined, undefined, undefined, execution);

  expect(execute.mock.calls[0]?.[4]).toBe(execution);
});
