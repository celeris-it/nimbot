import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/** Filesystem layout for subprocess-managed agents; removal retains this tree. */
export function agentProcessDirectories(
  dataDirectory: string,
  agentId: string,
) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(agentId))
    throw new Error("Invalid agent ID");
  const root = resolve(dataDirectory, "agents", agentId);
  return {
    root,
    workspace: resolve(root, "workspace"),
    tasks: resolve(root, "tasks"),
    home: resolve(root, "home"),
    data: resolve(root, "engine", "data"),
    config: resolve(root, "engine", "config"),
    cache: resolve(root, "engine", "cache"),
    state: resolve(root, "engine", "state"),
    browser: resolve(root, "browser"),
    temporary: resolve(root, "tmp"),
  };
}

/** Build a child environment explicitly; never spread the Server environment. */
export async function prepareAgentProcess(options: {
  dataDirectory: string;
  agentId: string;
  token: string;
  port: number;
  taskTimeoutSeconds: number;
  executablePath: string;
  playwrightBrowsersPath?: string;
  sharedEngineDirectory?: string;
}) {
  const directories = agentProcessDirectories(
    options.dataDirectory,
    options.agentId,
  );
  if (!/^[a-f0-9]{64}$/.test(options.token))
    throw new Error("Invalid Host credential");
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  )
    throw new Error("Invalid Agent Host port");
  if (
    !Number.isInteger(options.taskTimeoutSeconds) ||
    options.taskTimeoutSeconds < 10 ||
    options.taskTimeoutSeconds > 3600
  )
    throw new Error("Invalid task timeout");
  if (!options.executablePath.trim())
    throw new Error("Missing executable path");

  await mkdir(directories.root, { recursive: true, mode: 0o700 });
  await Promise.all(
    Object.values(directories).map((directory) =>
      mkdir(directory, { recursive: true, mode: 0o700 }),
    ),
  );
  const env: NodeJS.ProcessEnv = {
    PATH: options.executablePath,
    HOME: directories.home,
    XDG_DATA_HOME: directories.data,
    XDG_CONFIG_HOME: directories.config,
    XDG_CACHE_HOME: directories.cache,
    XDG_STATE_HOME: directories.state,
    TMPDIR: directories.temporary,
    WORKSPACE: directories.workspace,
    AGENT_STATE_DIR: directories.tasks,
    AGENT_BROWSER_PROFILE_DIR: directories.browser,
    AGENT_HOST_BIND_ADDRESS: "127.0.0.1",
    AGENT_HOST_PORT: String(options.port),
    AGENT_HOST_TOKEN: options.token,
    TASK_TIMEOUT_SECONDS: String(options.taskTimeoutSeconds),
    // Preserve Nimbot's existing OpenCode permission configuration.
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permissions: [{ action: "execute", resource: "*", effect: "deny" }],
    }),
    ...(options.sharedEngineDirectory
      ? { NIMBOT_SHARED_ENGINE_DIR: resolve(options.sharedEngineDirectory) }
      : {}),
    ...(options.playwrightBrowsersPath
      ? { PLAYWRIGHT_BROWSERS_PATH: resolve(options.playwrightBrowsersPath) }
      : {}),
  };
  return { directories, cwd: directories.workspace, env };
}
