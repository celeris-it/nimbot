import { resolve } from "node:path";
import type { PanelConfig } from "./panel-config.js";

export function readServerMode(env: NodeJS.ProcessEnv, panel: PanelConfig) {
  const mode = env.NIMBOT_MODE?.trim() || "docker";
  if (mode !== "native" && mode !== "docker")
    throw new Error("NIMBOT_MODE must be native or docker.");
  if (
    mode === "native" &&
    !["127.0.0.1", "::1", "localhost"].includes(panel.hostname)
  )
    throw new Error("Native development requires PANEL_HOST on loopback.");
  return {
    mode,
    stateDirectory: resolve(
      env.SERVER_STATE_DIR ||
        (mode === "native" ? ".nimbot-native" : ".nimbot"),
    ),
  };
}
