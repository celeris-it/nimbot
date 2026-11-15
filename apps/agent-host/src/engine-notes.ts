/** Facts about the Agent Host environment the engine cannot discover on its own. */
export const ENVIRONMENT_NOTES = [
  "Environment notes (not part of the user's request):",
  "- To read a public web page with a real browser, run in the terminal: node /app/apps/agent-host/dist/browser-demo.js <https-url>",
  "  It prints one JSON object with the final url, title and visible text, and exits non-zero with a JSON error if the page cannot be loaded.",
  "- Only open pages the user asked for or that are needed for the task. Summarize what you read; do not paste whole pages.",
].join("\n");

export function withEnvironmentNotes(prompt: string): string {
  return `${ENVIRONMENT_NOTES}\n\nUser task:\n${prompt}`;
}
