/**
 * Phase 0 validation: start a session, send a prompt, print streaming output.
 * Usage: node dist/demo.js "your prompt"   (workspace = $WORKSPACE or cwd)
 */
import { spawnOpenCode } from "./acp-client.js";
import { stopEngine } from "./stop-engine.js";

const text =
  process.argv.slice(2).join(" ") || "Say hello in one short sentence.";
const cwd = process.env.WORKSPACE ?? process.cwd();

const { client, process: child } = spawnOpenCode(cwd, {
  onUpdate: (_sessionId, update) => {
    const content = update.content as
      { type?: string; text?: string } | undefined;
    if (update.sessionUpdate === "agent_message_chunk" && content?.text) {
      process.stdout.write(content.text);
    } else if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      console.error(
        `\n[tool] ${String(update.title ?? update.toolCallId)} ${String(update.status ?? "")}`,
      );
    }
  },
  // Validation only: auto-approve. Real approvals arrive in Phase 3.
  onPermission: (options) =>
    (options.find((o) => o.kind === "allow_once") ?? options[0])?.optionId,
});

let activeSessionId: string | undefined;
let cancelling = false;
const interrupt = () => {
  if (!activeSessionId || cancelling) {
    child.kill();
    return;
  }
  cancelling = true;
  client.cancel(activeSessionId);
  console.error("\n[cancel] Requested; interrupt again to terminate.");
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

try {
  await client.initialize();
  const sessionId = process.env.ACP_SESSION_ID?.trim();
  if (sessionId) await client.loadSession(sessionId, cwd);
  activeSessionId = sessionId || (await client.newSession(cwd));
  console.error(`[session] ${activeSessionId}`);
  const stopReason = await client.prompt(activeSessionId, text);
  console.error(`\n[done] ${stopReason}`);
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  await stopEngine(child);
}
