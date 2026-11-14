import { spawnOpenCode } from "./acp-client.js";
import { stopEngine } from "./stop-engine.js";
import type { Engine } from "./engine.js";

export function createOpenCodeEngine(workspace: string): Engine {
  let active: ReturnType<typeof spawnOpenCode> | undefined;
  return {
    async run(prompt, onText) {
      const engine = spawnOpenCode(workspace, {
        onUpdate: (_id, update) => {
          const content = update.content as { text?: string } | undefined;
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            typeof content?.text === "string"
          )
            onText(content.text);
        },
        // Pending Telegram approval support: deny permission requests by default.
      });
      active = engine;
      try {
        await engine.client.initialize();
        const session = await engine.client.newSession(workspace);
        return await engine.client.prompt(session, prompt);
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
