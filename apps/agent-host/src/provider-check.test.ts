import { expect, it, vi } from "vitest";
import { checkApiKey } from "./provider-check.js";

it.each([
  ["openai", "api.openai.com", "Authorization", "Bearer candidate"],
  ["anthropic", "api.anthropic.com", "x-api-key", "candidate"],
  [
    "google",
    "generativelanguage.googleapis.com",
    "x-goog-api-key",
    "candidate",
  ],
  ["openrouter", "openrouter.ai", "Authorization", "Bearer candidate"],
] as const)(
  "checks %s over its authenticated HTTPS endpoint",
  async (id, host, header, value) => {
    const request = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );
    await expect(checkApiKey(id, "candidate", request)).resolves.toBe(
      "available",
    );
    const [url, init] = request.mock.calls[0]!;
    expect(new URL(String(url))).toMatchObject({
      protocol: "https:",
      hostname: host,
    });
    expect(String(url)).not.toContain("candidate");
    expect(new Headers(init?.headers).get(header)).toBe(value);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  },
);

it("distinguishes Gemini's explicit credential rejection from permission and transient errors", async () => {
  const request = vi.fn<typeof fetch>();
  request.mockResolvedValueOnce(
    Response.json(
      { error: { details: [{ reason: "API_KEY_INVALID" }] } },
      { status: 400 },
    ),
  );
  request.mockResolvedValueOnce(
    Response.json(
      { error: { details: [{ reason: "API_KEY_SERVICE_BLOCKED" }] } },
      { status: 403 },
    ),
  );
  request.mockResolvedValueOnce(
    new Response("Private provider details", { status: 503 }),
  );
  await expect(checkApiKey("google", "candidate", request)).resolves.toBe(
    "rejected",
  );
  await expect(checkApiKey("google", "candidate", request)).resolves.toBe(
    "restricted",
  );
  await expect(checkApiKey("google", "candidate", request)).resolves.toBe(
    "unavailable",
  );
});
