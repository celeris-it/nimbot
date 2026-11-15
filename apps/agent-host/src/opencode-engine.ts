import { spawnOpenCode } from "./acp-client.js";
import { stopEngine } from "./stop-engine.js";
import type { Engine } from "./engine.js";
import { withEnvironmentNotes } from "./engine-notes.js";

/** Single-line, bounded text for a tool step shown to the user. */
export function progressLabel(title: string) {
  const text = title.replace(/\s+/g, " ").trim().slice(0, 200);
  return `Using tool: ${text || "unnamed step"}`;
}

export function createOpenCodeEngine(workspace: string): Engine {
  let active: ReturnType<typeof spawnOpenCode> | undefined;
  return {
    async run(prompt, onText, onProgress) {
      const engine = spawnOpenCode(workspace, {
        onUpdate: (_id, update) => {
          const content = update.content as { text?: string } | undefined;
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            typeof content?.text === "string"
          )
            onText(content.text);
          else if (
            update.sessionUpdate === "tool_call" &&
            typeof update.title === "string"
          )
            onProgress?.(progressLabel(update.title));
        },
        // Pending Telegram approval support: deny permission requests by default.
      });
      active = engine;
      try {
        await engine.client.initialize();
        const session = await engine.client.newSession(workspace);
        return await engine.client.prompt(
          session,
          withEnvironmentNotes(prompt),
        );
      } finally {
        engine.client.close();
        if (engine.process.pid) await stopEngine(engine.process);
        if (active === engine) active = undefined;
      }
    },
    async stop() {
      if (!active) return;
      active.client.close();
      if (active.process.pid) await stopEngine(active.process);
    },
  };
}
