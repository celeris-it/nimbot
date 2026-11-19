import { z } from "zod";
import type { AgentHostConfig } from "./agent-host.js";
import {
  providers,
  providerCheckStates,
  type ProviderCheck,
  type ProviderId,
  type ProviderSettings,
  type DeviceLogin,
  type DeviceProvider,
} from "./provider-contracts.js";

const providerChecks = z
  .array(
    z.object({
      id: z.enum(providers.map(({ id }) => id)),
      state: z.enum(providerCheckStates),
      checkedAt: z.int().nonnegative().max(8_640_000_000_000_000),
      revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    }),
  )
  .length(providers.length);

const providerErrorStatuses = [400, 403, 404, 409, 422, 429, 502, 503] as const;
type ProviderErrorStatus = (typeof providerErrorStatuses)[number];

export class HostProviderError extends Error {
  constructor(readonly status: ProviderErrorStatus) {
    super("Provider request failed");
  }
}
function login(value: unknown, expected?: DeviceProvider): DeviceLogin {
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
  const provider = data.provider ?? "openai";
  if (
    (provider !== "openai" && provider !== "opencode") ||
    (expected && expected !== provider)
  )
    throw new HostProviderError(503);
  if (data.provider !== undefined) result.provider = provider;
  if (result.state === "awaiting_authorization") {
    const url =
      typeof data.url === "string" &&
      data.url.length <= 2048 &&
      URL.canParse(data.url)
        ? new URL(data.url)
        : undefined;
    if (
      !url ||
      url.username ||
      url.password ||
      (provider === "openai"
        ? url.href !== "https://auth.openai.com/codex/device"
        : url.origin !== "https://opencode.ai" ||
          !url.pathname.startsWith("/console/")) ||
      typeof data.code !== "string" ||
      !/^[A-Za-z0-9-]{4,32}$/.test(data.code)
    )
      throw new HostProviderError(503);
    result.url = url.href;
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
        signal: AbortSignal.timeout(body && "key" in body ? 30_000 : 20_000),
        redirect: "error",
      });
      if (!response.ok)
        throw new HostProviderError(
          providerErrorStatuses.find((status) => status === response.status) ??
            503,
        );
      return await response.json();
    } catch (error) {
      if (error instanceof HostProviderError) throw error;
      throw new HostProviderError(503);
    }
  }
  return {
    async checks(
      id: string,
    ): Promise<(ProviderCheck & { revision: string | null })[]> {
      const parsed = providerChecks.safeParse(await call(id, "/checks"));
      if (
        !parsed.success ||
        new Set(parsed.data.map((entry) => entry.id)).size !== providers.length
      )
        throw new HostProviderError(503);
      return parsed.data;
    },
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
            (entry.method === "device" &&
              provider.id !== "openai" &&
              provider.id !== "opencode")
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
    async startLogin(id: string, provider: DeviceProvider = "openai") {
      return login(await call(id, `/${provider}/device-login`, {}), provider);
    },
    async cancelLogin(
      id: string,
      attempt: string,
      provider: DeviceProvider = "openai",
    ) {
      return login(
        await call(
          id,
          `/${provider}/device-login/${encodeURIComponent(attempt)}/cancel`,
          {},
        ),
        provider,
      );
    },
  };
}
