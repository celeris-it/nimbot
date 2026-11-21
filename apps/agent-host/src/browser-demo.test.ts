import { describe, expect, it } from "vitest";
import { browserProfileDirectory, parseBrowseUrl } from "./browser-demo.js";
import { resolve } from "node:path";
import {
  browserCommand,
  ENVIRONMENT_NOTES,
  withEnvironmentNotes,
} from "./engine-notes.js";

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
    expect(ENVIRONMENT_NOTES).toContain(browserCommand());
    expect(prompt.endsWith("User task:\nSummarize example.org")).toBe(true);
  });

  it("gives the user's language preference precedence over the English fallback", () => {
    const task = "Please reply in Spanish.";
    const prompt = withEnvironmentNotes(task);
    expect(prompt).toContain("Reply in the language the user requests.");
    expect(prompt).toContain(
      "follow the language of the conversation and use English as the fallback",
    );
    expect(prompt).toContain(
      "Project language conventions apply to project materials.",
    );
    expect(prompt.endsWith(`User task:\n${task}`)).toBe(true);
  });
});

it("uses the assigned native profile or a persistent task-state profile in containers", () => {
  expect(
    browserProfileDirectory({
      AGENT_BROWSER_PROFILE_DIR: "/data/agents/one/browser",
      AGENT_STATE_DIR: "/tasks",
    }),
  ).toBe("/data/agents/one/browser");
  expect(browserProfileDirectory({ AGENT_STATE_DIR: "/tasks" })).toBe(
    "/tasks/browser",
  );
  expect(browserProfileDirectory({})).toBe(
    "/home/node/.local/share/nimbot/browser",
  );
  expect(
    browserProfileDirectory({ AGENT_BROWSER_PROFILE_DIR: "relative" }),
  ).toBe(resolve("relative"));
});
