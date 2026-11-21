import { homedir, platform } from "node:os";
import { join } from "node:path";
import process from "node:process";

process.env.NIMBOT_MODE = "native";
// Host homes and caches are per agent; share the installed Chromium binaries.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(
  platform() === "darwin"
    ? join(homedir(), "Library", "Caches")
    : process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "ms-playwright",
);
await import("../apps/server/dist/index.js");
