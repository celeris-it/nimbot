/** Browser-safe provider metadata; credential values are never part of these types. */
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
