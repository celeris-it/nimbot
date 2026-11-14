/**
 * Phase 0 validation: start a session, send a prompt, print streaming output.
 * Usage: node dist/demo.js "your prompt"   (workspace = $WORKSPACE or cwd)
 */
import { spawnOpenCode } from "./acp-client.js";

const text =
  process.argv.slice(2).join(" ") || "Say hello in one short sentence.";
const cwd = process.env.WORKSPACE ?? process.cwd();

const { client, process: child } = spawnOpenCode(cwd, {
  onUpdate: (_sessionId, update) => {
    const content = update.content as
      { type?: string; text?: string } | undefined;
    if (update.sessionUpdate === "agent_message_chunk" && content?.text) {
      process.stdout.write(content.text);
    } else if (update.sessionUpdate === "tool_call") {
      console.error(`\n[tool] ${String(update.title ?? update.toolCallId)}`);
    }
  },
  // Validation only: auto-approve. Real approvals arrive in Phase 3.
  onPermission: (options) =>
    (options.find((o) => o.kind === "allow_once") ?? options[0])?.optionId,
});

process.on("SIGINT", () => child.kill());

try {
  await client.initialize();
  const sessionId = await client.newSession(cwd);
  console.error(`[session] ${sessionId}`);
  const stopReason = await client.prompt(sessionId, text);
  console.error(`\n[done] ${stopReason}`);
} finally {
  child.kill();
}
