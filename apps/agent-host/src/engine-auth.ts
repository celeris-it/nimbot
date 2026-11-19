/** Authentication boundary: no engine-specific credential formats or tokens leave it. */
export const providers = [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "google", name: "Google" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "opencode", name: "OpenCode Console" },
] as const;
export type ProviderId = (typeof providers)[number]["id"];
export function isProviderId(id: string): id is ProviderId {
  return providers.some((provider) => provider.id === id);
}
export function isApiKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= 4096 &&
    !/\s/.test(key) &&
    !key.includes("\0")
  );
}
export type DeviceProvider = "openai" | "opencode";

export interface DeviceLogin {
  provider?: DeviceProvider;
  id: string;
  state:
    | "starting"
    | "awaiting_authorization"
    | "completed"
    | "failed"
    | "cancelled"
    | "expired";
  url?: string;
  code?: string;
}
export interface ProviderSettings {
  providers: {
    id: ProviderId;
    name: string;
    method: "api_key" | "device" | null;
  }[];
  busy: boolean;
  login: DeviceLogin | null;
}
export class EngineAuthError extends Error {
  constructor(
    readonly kind:
      | "busy"
      | "invalid"
      | "not_found"
      | "unavailable"
      | "rejected"
      | "restricted"
      | "rate_limited"
      | "check_unavailable",
  ) {
    super(kind);
  }
}
export interface EngineAuth {
  checkProviders(): Promise<(ProviderCheck & { revision: string | null })[]>;
  status(): Promise<ProviderSettings>;
  save(id: ProviderId, key: string): Promise<void>;
  remove(id: ProviderId): Promise<void>;
  startLogin(provider?: DeviceProvider): DeviceLogin;
  cancelLogin(id: string, provider?: DeviceProvider): Promise<DeviceLogin>;
  close(): Promise<void>;
}

export const providerCheckStates = [
  "available",
  "rejected",
  "restricted",
  "rate_limited",
  "unavailable",
  "unverified",
  "not_configured",
] as const;
export type ProviderCheckState = (typeof providerCheckStates)[number];
export interface ProviderCheck {
  id: ProviderId;
  state: ProviderCheckState;
  checkedAt: number;
}
