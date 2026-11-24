import { expect, it } from "vitest";
import { taskPromptWithInstructions } from "./task-instructions.js";

it.each([
  [{}, "Task"],
  [{ sharedRules: "  ", agentRules: "\n" }, "Task"],
  [
    { sharedRules: "Default" },
    "Shared rules (defaults):\nDefault\n\nUser task:\nTask",
  ],
  [
    { agentRules: "Individual" },
    "Agent rules:\nIndividual\n\nUser task:\nTask",
  ],
  [
    { instructions: "Be brief" },
    "Agent instructions:\nBe brief\n\nUser task:\nTask",
  ],
  [
    { sharedRules: "Default", instructions: "Be brief", agentRules: "Own" },
    "Follow the agent instructions and agent rules wherever they conflict with the shared rules.\n\nShared rules (defaults):\nDefault\n\nAgent instructions:\nBe brief\n\nAgent rules:\nOwn\n\nUser task:\nTask",
  ],
])("formats a task with %j", (instructions, expected) => {
  expect(taskPromptWithInstructions({ prompt: "Task", ...instructions })).toBe(
    expected,
  );
});
