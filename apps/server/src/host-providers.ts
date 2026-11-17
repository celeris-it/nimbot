import type { AgentHostConfig } from "./agent-host.js";
import {
  providers,
  type ProviderId,
  type ProviderSettings,
  type DeviceLogin,
} from "./provider-contracts.js";

export class HostProviderError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503) {
    super("Provider request failed");
  }
}
function login(value: unknown): DeviceLogin {
  if (!value || typeof value !== "object") throw new HostProviderError(503);
  const data = value as Record<string, unknown>;
  if (
    typeof data.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(data.id) ||
    ![
      "starting",
      "awaiting_authorization",
      "completed",
      "failed",
      "cancelled",
      "expired",
    ].includes(String(data.state))
  )
    throw new HostProviderError(503);
  const result: DeviceLogin = {
    id: data.id,
    state: data.state as DeviceLogin["state"],
  };
  if (result.state === "awaiting_authorization") {
    if (
      data.url !== "https://auth.openai.com/codex/device" ||
      typeof data.code !== "string" ||
      !/^[A-Za-z0-9-]{4,32}$/.test(data.code)
    )
      throw new HostProviderError(503);
    result.url = data.url;
    result.code = data.code;
  }
  return result;
}

/** Fixed authenticated operations to the registered agent; never proxy arbitrary URLs or raw bodies. */
export function createHostProviders(
  resolve: (id: string) => Promise<AgentHostConfig>,
  request: typeof fetch = fetch,
) {
  async function call(
    id: string,
    path: string,
    body?: object,
  ): Promise<unknown> {
    try {
      const host = await resolve(id);
      const response = await request(`${host.url}/providers${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${host.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok)
        throw new HostProviderError(
          ([400, 404, 409].includes(response.status)
            ? response.status
            : 503) as 400 | 404 | 409 | 503,
        );
      return await response.json();
    } catch (error) {
      if (error instanceof HostProviderError) throw error;
      throw new HostProviderError(503);
    }
  }
  return {
    async status(id: string): Promise<ProviderSettings> {
      const raw = await call(id, "");
      if (!raw || typeof raw !== "object") throw new HostProviderError(503);
      const data = raw as Record<string, unknown>;
      if (!Array.isArray(data.providers) || typeof data.busy !== "boolean")
        throw new HostProviderError(503);
      return {
        providers: providers.map((provider) => {
          const entry = (data.providers as Record<string, unknown>[]).find(
            (entry) => entry?.id === provider.id,
          );
          if (
            !entry ||
            ![null, "api_key", "device"].includes(
              entry.method as null | string,
            ) ||
            (entry.method === "device" && provider.id !== "openai")
          )
            throw new HostProviderError(503);
          return {
            ...provider,
            method: entry.method as "api_key" | "device" | null,
          };
        }),
        busy: data.busy,
        login: data.login === null ? null : login(data.login),
      };
    },
    async save(id: string, provider: ProviderId, key: string) {
      await call(id, `/${provider}`, { key });
    },
    async remove(id: string, provider: ProviderId) {
      await call(id, `/${provider}/remove`, {});
    },
    async startLogin(id: string) {
      return login(await call(id, "/openai/device-login", {}));
    },
    async cancelLogin(id: string, attempt: string) {
      return login(
        await call(
          id,
          `/openai/device-login/${encodeURIComponent(attempt)}/cancel`,
          {},
        ),
      );
    },
  };
}
