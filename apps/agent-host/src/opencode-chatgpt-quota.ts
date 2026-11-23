import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ModelCheck } from "./engine-usage.js";

const session = z.object({
  type: z.literal("oauth"),
  methodID: z.literal("chatgpt-headless"),
  access: z.string().min(1),
  accountID: z.string().nullish(),
  expires: z.int().positive(),
});
const usage = z.object({
  rate_limit: z.object({
    primary_window: z.unknown(),
    secondary_window: z.unknown(),
  }),
});
const windowSnapshot = z.object({
  used_percent: z.number().min(0).max(100),
  limit_window_seconds: z.int().positive(),
  reset_at: z.int().positive().max(8_640_000_000_000),
});

function readSession(database: string, id: string) {
  if (!existsSync(database)) return undefined;
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT value FROM credential WHERE id = ? AND active = 1 AND integration_id = 'openai'",
      )
      .get(id);
    if (typeof row?.value !== "string") return undefined;
    const parsed = session.safeParse(JSON.parse(row.value));
    return parsed.success && parsed.data.expires > Date.now()
      ? parsed.data
      : undefined;
  } finally {
    db.close();
  }
}

type Windows = ModelCheck["windows"];

export function createOpenCodeChatGptQuota(
  directory: string | undefined,
  request: typeof fetch = fetch,
) {
  const database = directory ? resolve(directory, "opencode.db") : undefined;
  let cached:
    { id: string; expires: number; windows: Promise<Windows> } | undefined;

  async function fetchWindows(
    credential: z.infer<typeof session>,
  ): Promise<Windows> {
    const response = await request(
      "https://chatgpt.com/backend-api/wham/usage",
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credential.access}`,
          ...(credential.accountID
            ? { "ChatGPT-Account-Id": credential.accountID }
            : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      },
    );
    if (!response.ok) return [];
    const parsed = usage.safeParse(await response.json());
    if (!parsed.success) return [];
    const { primary_window, secondary_window } = parsed.data.rate_limit;
    const windows: Windows = [];
    for (const [raw, fallback] of [
      [primary_window, "ChatGPT primary"],
      [secondary_window, "ChatGPT secondary"],
    ] as const) {
      const window = windowSnapshot.safeParse(raw);
      if (!window.success) continue;
      const { used_percent, limit_window_seconds, reset_at } = window.data;
      windows.push({
        name:
          limit_window_seconds === 18_000
            ? "ChatGPT 5-hour"
            : limit_window_seconds === 604_800
              ? "ChatGPT weekly"
              : fallback,
        usedPercent: used_percent,
        exhausted: used_percent === 100,
        resetsAt: reset_at * 1_000,
      });
    }
    return windows;
  }

  return async function chatGptQuota(id: string): Promise<Windows> {
    if (!database) return [];
    try {
      const credential = readSession(database, id);
      if (!credential) return [];
      const now = Date.now();
      if (cached?.id === id && now < cached.expires) return cached.windows;
      const windows = fetchWindows(credential).catch(() => []);
      cached = { id, expires: now + 30_000, windows };
      return windows;
    } catch {
      return [];
    }
  };
}
