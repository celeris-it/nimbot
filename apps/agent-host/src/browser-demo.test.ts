import { describe, expect, it } from "vitest";
import { parseBrowseUrl } from "./browser-demo.js";
import { ENVIRONMENT_NOTES, withEnvironmentNotes } from "./engine-notes.js";

describe("browser probe input", () => {
  it("accepts plain http and https pages", () => {
    expect(parseBrowseUrl("https://example.org/a?b=1").href).toBe(
      "https://example.org/a?b=1",
    );
    expect(parseBrowseUrl("http://example.org").protocol).toBe("http:");
  });
  it.each([
    undefined,
    "",
    "not a url",
    "file:///etc/passwd",
    "chrome://settings",
    "data:text/html,hi",
    "javascript:alert(1)",
    "https://user:pass@example.org",
  ])("rejects %s", (input) => {
    expect(() => parseBrowseUrl(input)).toThrow();
  });
});

describe("environment notes", () => {
  it("tell the engine how to use the browser without altering the user's task", () => {
    const prompt = withEnvironmentNotes("Summarize example.org");
    expect(ENVIRONMENT_NOTES).toContain(
      "node /app/apps/agent-host/dist/browser-demo.js",
    );
    expect(prompt.endsWith("User task:\nSummarize example.org")).toBe(true);
  });
});
