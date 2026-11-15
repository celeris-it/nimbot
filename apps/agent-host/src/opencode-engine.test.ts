import { expect, it } from "vitest";
import { progressLabel } from "./opencode-engine.js";

it("turns a tool title into one bounded line", () => {
  expect(progressLabel("  Run\n  ls   -la  ")).toBe("Using tool: Run ls -la");
  expect(progressLabel("x".repeat(500))).toHaveLength(
    "Using tool: ".length + 200,
  );
  expect(progressLabel("   ")).toBe("Using tool: unnamed step");
});
