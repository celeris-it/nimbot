import { expect, it } from "vitest";
import { progressLabel } from "./opencode-engine.js";

it("turns a tool title into one bounded line", () => {
  expect(progressLabel("  Run\n  ls   -la  ")).toBe("Using tool: Run ls -la");
  expect(progressLabel("x".repeat(500))).toHaveLength(
    "Using tool: ".length + 200,
  );
  expect(progressLabel("   ")).toBe("Using tool: unnamed step");
});

import { chooseOption, describeAction } from "./opencode-engine.js";

it("grants a single action only and denies with a reject option", () => {
  const options = [
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "once", name: "Once", kind: "allow_once" },
    { optionId: "no", name: "No", kind: "reject_once" },
  ];
  expect(chooseOption(options, true)).toBe("once");
  expect(chooseOption(options, false)).toBe("no");
  // Never falls back to a broader grant when only "always" is offered.
  expect(chooseOption([options[0]!], true)).toBeUndefined();
  expect(chooseOption([options[0]!], false)).toBeUndefined();
});

it("describes the requested action on one bounded line", () => {
  expect(describeAction({ title: " read\n /etc/hostname " })).toBe(
    "read /etc/hostname",
  );
  expect(describeAction({ title: "/etc", kind: "read" })).toBe("read: /etc");
  expect(describeAction({ title: "read /etc", kind: "read" })).toBe(
    "read /etc",
  );
  expect(describeAction({ kind: "execute" })).toBe("execute");
  expect(describeAction({})).toBe("an action the agent did not describe");
  expect(describeAction({ title: "x".repeat(500) })).toHaveLength(200);
});
