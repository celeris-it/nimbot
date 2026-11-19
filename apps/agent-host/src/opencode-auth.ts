import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  EngineAuthError,
  isApiKey,
  providers,
  type DeviceLogin,
  type DeviceProvider,
  type EngineAuth,
  type ProviderId,
  type ProviderCheckState,
  type ProviderCheck,
} from "./engine-auth.js";
import { checkApiKey } from "./provider-check.js";
import type { OpenCodeRequest } from "./opencode-api.js";

const credentialValue = z.object({
  type: z.enum(["key", "oauth", "external"]),
});
const credentialEntry = z.object({
  id: z.string(),
  integrationID: z.string(),
  active: z.boolean(),
  value: credentialValue,
});
const credentialList = z.object({ data: z.array(credentialEntry) });
const probeCredentialList = z.object({
  data: z.array(
    credentialEntry.extend({
      value: credentialValue.extend({ key: z.string().optional() }),
    }),
  ),
});
const connectionList = z.object({
  data: z.object({
    connections: z.array(
      z.object({
        type: z.string(),
        id: z.string().optional(),
        status: z.object({ status: z.string() }).optional(),
      }),
    ),
  }),
});
const authorization = z.object({
  data: z.object({
    attemptID: z.string().min(1),
    url: z.url(),
    instructions: z.string(),
    mode: z.literal("auto"),
  }),
});
const attemptStatus = z.object({
  data: z.object({
    status: z.enum(["pending", "complete", "failed", "expired"]),
  }),
});

export async function readOpenCodeCredentials(request: OpenCodeRequest) {
  return credentialList.parse(await request("/api/credential")).data;
}

const pending = (login: DeviceLogin) =>
  login.state === "starting" || login.state === "awaiting_authorization";

export function deviceAuthorizationUrl(
  provider: DeviceProvider,
  value: string,
) {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    (provider === "openai"
      ? value === "https://auth.openai.com/codex/device"
      : url.origin === "https://opencode.ai" &&
        url.pathname.startsWith("/console/"))
  );
}

/** OpenCode owns its credentials. This adapter exports only connection status and device instructions. */
export function createOpenCodeAuth(
  request: OpenCodeRequest,
  reserve: () => (() => void) | undefined,
  isBusy: () => boolean,
  changed: () => void,
  options: {
    loginTimeoutMs?: number;
    pollMs?: number;
    fetch?: typeof fetch;
  } = {},
): EngineAuth {
  let closed = false;
  type Check = ProviderCheck & { revision: string | null };
  let cached: { entries: Check[]; expiresAt: number } | undefined;
  let checking: Promise<Check[]> | undefined;
  let generation = 0;

  function credentialsChanged() {
    generation++;
    cached = undefined;
    checking = undefined;
    changed();
  }

  async function checkProviders(current: number): Promise<Check[]> {
    const credentials = await request("/api/credential")
      .then((raw) => probeCredentialList.parse(raw).data)
      .catch(() => {
        throw new EngineAuthError("unavailable");
      });
    const entries = await Promise.all(
      providers.map(async ({ id }) => {
        const credential = credentials.find(
          (entry) => entry.active && entry.integrationID === id,
        );
        let state: ProviderCheckState = "not_configured";
        if (credential?.value.type === "key") {
          state =
            id !== "opencode" && credential.value.key
              ? await checkApiKey(id, credential.value.key, options.fetch)
              : "unverified";
        } else if (credential?.value.type === "oauth") {
          state = "unverified";
          const raw = await request(`/api/integration/${id}`).catch(() => null);
          const result = connectionList.safeParse(raw);
          if (
            result.success &&
            result.data.data.connections.some(
              (connection) =>
                connection.type === "credential" &&
                connection.id === credential.id &&
                connection.status?.status === "needs_auth",
            )
          )
            state = "rejected";
        } else if (credential) {
          state = "unverified";
        }
        return {
          id,
          state,
          checkedAt: Date.now(),
          revision: credential
            ? createHash("sha256").update(credential.id).digest("hex")
            : null,
        };
      }),
    );
    if (current !== generation) throw new EngineAuthError("unavailable");
    cached = { entries, expiresAt: Date.now() + 300_000 };
    return entries;
  }
  let attempt:
    | {
        public: DeviceLogin;
        cancel: AbortController;
        done: Promise<void>;
      }
    | undefined;

  function acquire() {
    if (closed) throw new EngineAuthError("unavailable");
    const release = reserve();
    if (!release) throw new EngineAuthError("busy");
    return release;
  }

  async function removeCredentials(ids: string[]) {
    for (const id of ids)
      await request(`/api/credential/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
  }

  async function mutate(provider: ProviderId, key?: string) {
    const release = acquire();
    let mutating = false;
    try {
      if (key !== undefined && provider !== "opencode") {
        const state = await checkApiKey(provider, key, options.fetch);
        if (state !== "available") {
          throw new EngineAuthError(
            state === "rejected" ||
              state === "restricted" ||
              state === "rate_limited"
              ? state
              : "check_unavailable",
          );
        }
      }
      const previous = (await readOpenCodeCredentials(request))
        .filter((entry) => entry.integrationID === provider)
        .map((entry) => entry.id);
      mutating = true;
      if (key !== undefined)
        await request("/api/credential", {
          body: {
            integrationID: provider,
            value: { type: "key", key },
            activate: true,
          },
        });
      await removeCredentials(previous);
      if (attempt?.public.provider === provider) attempt = undefined;
    } catch (error) {
      if (error instanceof EngineAuthError) throw error;
      throw new EngineAuthError("unavailable");
    } finally {
      if (mutating) credentialsChanged();
      release();
    }
  }

  return {
    async checkProviders() {
      if (cached && Date.now() < cached.expiresAt) return cached.entries;
      if (checking) return checking;
      const current = checkProviders(generation);
      checking = current;
      try {
        return await current;
      } finally {
        if (checking === current) checking = undefined;
      }
    },
    async status() {
      const credentials = await readOpenCodeCredentials(request).catch(() => {
        throw new EngineAuthError("unavailable");
      });
      return {
        providers: providers.map((provider) => {
          const type = credentials.find(
            (entry) => entry.active && entry.integrationID === provider.id,
          )?.value.type;
          return {
            ...provider,
            method:
              type === "oauth" ? "device" : type === "key" ? "api_key" : null,
          };
        }),
        busy: isBusy(),
        login: attempt ? { ...attempt.public } : null,
      };
    },
    save(provider, key) {
      if (!isApiKey(key) || provider === "opencode")
        throw new EngineAuthError("invalid");
      return mutate(provider, key);
    },
    remove: (provider) => mutate(provider),
    startLogin(provider = "openai") {
      const release = acquire();
      const current: NonNullable<typeof attempt> = {
        public: { id: randomUUID(), provider, state: "starting" },
        cancel: new AbortController(),
        done: Promise.resolve(),
      };
      attempt = current;
      const deadline = AbortSignal.timeout(options.loginTimeoutMs ?? 600_000);
      const signal = AbortSignal.any([deadline, current.cancel.signal]);
      const path = `/api/integration/${provider}/connect/oauth`;
      current.done = (async () => {
        let remote: string | undefined;
        let state: DeviceLogin["state"] = "failed";
        let previous: string[] = [];
        try {
          previous = (await readOpenCodeCredentials(request))
            .filter((entry) => entry.integrationID === provider)
            .map((entry) => entry.id);
          signal.throwIfAborted();
          const data = authorization.parse(
            await request(path, {
              body: {
                methodID:
                  provider === "opencode" ? "device" : "chatgpt-headless",
              },
            }),
          ).data;
          remote = `${path}/${encodeURIComponent(data.attemptID)}`;
          signal.throwIfAborted();
          const code = /Enter code:\s*([A-Za-z0-9-]{4,32})(?:\s|$)/.exec(
            data.instructions,
          )?.[1];
          if (!code || !deviceAuthorizationUrl(provider, data.url))
            throw new Error("Invalid device instructions");
          current.public = {
            ...current.public,
            state: "awaiting_authorization",
            url: data.url,
            code,
          };
          while (!signal.aborted) {
            const { data } = attemptStatus.parse(await request(remote));
            if (data.status === "complete") {
              state = "completed";
              break;
            }
            if (data.status !== "pending") {
              state = data.status;
              break;
            }
            await delay(options.pollMs ?? 1_000, undefined, { signal });
          }
        } catch {
          /* Preserve the previous connection on an unsuccessful authorization. */
        } finally {
          if (remote && state !== "completed") {
            await request(remote, { method: "DELETE" }).catch(() => {});
            // OpenCode may already be committing the credential when cancellation arrives.
            for (let attempt = 0; signal.aborted && attempt < 3; attempt++) {
              const raw = await request(remote, { timeout: 500 }).catch(
                () => null,
              );
              const parsed = attemptStatus.safeParse(raw);
              if (!parsed.success) break;
              if (parsed.data.data.status === "complete") state = "completed";
              if (parsed.data.data.status !== "pending") break;
              await delay(50);
            }
          }
          if (state === "completed")
            await removeCredentials(previous).catch(() => {});
          current.public = {
            id: current.public.id,
            provider,
            state:
              state === "completed"
                ? state
                : current.cancel.signal.aborted
                  ? "cancelled"
                  : deadline.aborted
                    ? "expired"
                    : state,
          };
          credentialsChanged();
          release();
        }
      })();
      return { ...current.public };
    },
    async cancelLogin(id, provider = "openai") {
      const current = attempt;
      if (
        !current ||
        current.public.id !== id ||
        current.public.provider !== provider
      )
        throw new EngineAuthError("not_found");
      if (pending(current.public)) current.cancel.abort();
      await current.done;
      return { ...current.public };
    },
    async close() {
      closed = true;
      attempt?.cancel.abort();
      await attempt?.done;
    },
  };
}
