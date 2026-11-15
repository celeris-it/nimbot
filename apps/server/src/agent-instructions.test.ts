import { expect, it, vi } from "vitest";
import { withAgentInstructions } from "./agent-instructions.js";

it("snapshots instructions per task and leaves bare prompts unchanged", async () => {
  let instructions = "First instructions";
  const execute = vi.fn().mockResolvedValue("done");
  const run = withAgentInstructions(execute, () => instructions);
  const first = run("first task");
  instructions = "New instructions";
  await first;
  await run("second task");
  expect(execute.mock.calls[0]?.[0]).toBe(
    "Agent instructions:\nFirst instructions\n\nUser task:\nfirst task",
  );
  expect(execute.mock.calls[1]?.[0]).toContain("New instructions");
  instructions = "";
  await run("plain");
  expect(execute).toHaveBeenLastCalledWith("plain", undefined, undefined);
});
