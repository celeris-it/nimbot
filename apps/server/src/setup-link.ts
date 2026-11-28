import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PanelAuthStatus } from "./panel/panel-contracts.js";
import { readPanelConfig } from "./panel/panel-config.js";
import { readServerMode } from "./server-mode.js";

try {
  const config = readPanelConfig(process.env);
  const mode = readServerMode(process.env, config);
  const address = ["::", "::1"].includes(config.hostname)
    ? "[::1]"
    : config.hostname === "0.0.0.0"
      ? "127.0.0.1"
      : config.hostname;
  const response = await fetch(
    `http://${address}:${config.port}/api/auth/status`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!response.ok) throw new Error("Authentication is not ready.");
  const status = (await response.json()) as PanelAuthStatus;
  if (!status.setupRequired) {
    console.log(`${config.origin}/login`);
    process.exit(0);
  }
  let token = "";
  try {
    token = await readFile(
      join(mode.stateDirectory, "panel-auth", "setup-token"),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid setup token.");
  console.log(`${config.origin}/setup#token=${token}`);
} catch {
  console.error(
    "Could not read the activation link. Check that Nimbot has started and its state directory is accessible.",
  );
  process.exitCode = 1;
}
