import type { ProviderCheckState, ProviderId } from "./engine-auth.js";

const endpoints = {
  openai: "https://api.openai.com/v1/models",
  anthropic: "https://api.anthropic.com/v1/models?limit=1",
  google: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
  openrouter: "https://openrouter.ai/api/v1/key",
} as const;

async function googleRejected(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) return false;
      body += decoder.decode(value, { stream: true });
    }
    const details: unknown = JSON.parse(body + decoder.decode()).error?.details;
    return (
      Array.isArray(details) &&
      details.some((detail) =>
        ["API_KEY_INVALID", "API_KEY_EXPIRED"].includes(detail?.reason),
      )
    );
  } catch {
    return false;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export async function checkApiKey(
  provider: Exclude<ProviderId, "opencode">,
  key: string,
  request: typeof fetch = fetch,
): Promise<ProviderCheckState> {
  const headers =
    provider === "google"
      ? { "x-goog-api-key": key }
      : provider === "anthropic"
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${key}` };
  try {
    const response = await request(endpoints[provider], {
      headers: new Headers(Object.entries(headers)),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (provider === "google" && [400, 403].includes(response.status)) {
      if (await googleRejected(response)) return "rejected";
      return response.status === 403 ? "restricted" : "unavailable";
    }
    void response.body?.cancel().catch(() => {});
    if (response.ok) return "available";
    if (response.status === 401) return "rejected";
    if (response.status === 403) return "restricted";
    if (response.status === 429) return "rate_limited";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}
