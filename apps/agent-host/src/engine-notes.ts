import { fileURLToPath } from "node:url";

/** Quote fixed executable paths for the POSIX terminal, including spaces and shell metacharacters. */
export function browserCommand(
  node = process.execPath,
  script = fileURLToPath(new URL("./browser-demo.js", import.meta.url)),
) {
  const quote = (path: string) => "'" + path.replaceAll("'", "'\\''") + "'";
  return `${quote(node)} ${quote(script)}`;
}

/** Facts about the Agent Host environment the engine cannot discover on its own. */
export const ENVIRONMENT_NOTES = [
  "Environment notes (not part of the user's request):",
  `- To read a public web page with a real browser, run in the terminal: ${browserCommand()} <https-url>`,
  "  It prints one JSON object with the final url, title and visible text, and exits non-zero with a JSON error if the page cannot be loaded.",
  "  This agent has its own persistent browser profile. Cookies and local storage survive later calls and restarts. Run one browser probe at a time; a concurrent call using the same profile may fail while it is in use.",
  "- Only open pages the user asked for or that are needed for the task. Summarize what you read; do not paste whole pages.",
].join("\n");

export function withEnvironmentNotes(prompt: string): string {
  return `${ENVIRONMENT_NOTES}\n\nUser task:\n${prompt}`;
}
