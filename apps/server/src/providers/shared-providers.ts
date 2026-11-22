import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentProcessManager } from "../processes/agent-process-manager.js";
import { createHostProviders } from "./host-providers.js";
import type { DeviceProvider, ProviderId } from "./provider-contracts.js";

export function createSharedProviders(options: {
  directory: string;
  executablePath: string;
  conflicts: () => ReadonlySet<ProviderId>;
  changed: () => void;
}) {
  const id = "management";
  const token = randomBytes(32).toString("hex");
  const manager = createAgentProcessManager({
    dataDirectory: options.directory,
    hostEntrypoint: fileURLToPath(
      new URL("../../../agent-host/dist/serve-providers.js", import.meta.url),
    ),
    executablePath: options.executablePath,
    sharedEngineDirectory: resolve(options.directory),
    taskTimeoutSeconds: 600,
    token: async () => token,
    store: { list: () => [], setDesiredState() {}, remove() {} },
    onProviderChange: options.changed,
  });
  const client = createHostProviders(
    async () => manager.host(id) ?? manager.start(id),
  );
  return {
    checks: () => client.checks(id),
    async status() {
      const status = await client.status(id);
      const conflicts = options.conflicts();
      return {
        ...status,
        providers: status.providers.map((entry) => ({
          ...entry,
          ...(!entry.method && conflicts.has(entry.id)
            ? { reconnectRequired: true }
            : {}),
        })),
      };
    },
    save: (provider: ProviderId, key: string) => client.save(id, provider, key),
    remove: (provider: ProviderId) => client.remove(id, provider),
    startLogin: (provider?: DeviceProvider) => client.startLogin(id, provider),
    cancelLogin: (attempt: string, provider?: DeviceProvider) =>
      client.cancelLogin(id, attempt, provider),
    close: manager.close,
  };
}
