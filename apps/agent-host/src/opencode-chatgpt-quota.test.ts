import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpenCodeChatGptQuota } from "./opencode-chatgpt-quota.js";

let directory: string;
let db: DatabaseSync;
const fixture = {
  type: "oauth",
  methodID: "chatgpt-headless",
  access: "fixture-access",
  accountID: "fixture-account",
  refresh: "fixture-refresh",
};
const window = {
  limit_window_seconds: 18_000,
  reset_at: 2_000_000_000,
  used_percent: 100,
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "nimbot-chatgpt-quota-"));
  db = new DatabaseSync(join(directory, "opencode.db"));
  db.exec(
    "CREATE TABLE credential (id TEXT, integration_id TEXT, active INTEGER, value TEXT)",
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function save(id: string, fields: Record<string, unknown> = {}) {
  db.exec("UPDATE credential SET active = 0");
  db.prepare("INSERT INTO credential VALUES (?, 'openai', 1, ?)").run(
    id,
    JSON.stringify({ ...fixture, expires: Date.now() + 60_000, ...fields }),
  );
}

it("reads both quota windows, shares concurrent calls and replaces expired cache entries", async () => {
  const clock = vi.spyOn(Date, "now");
  const now = Date.now();
  save("first");
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({
      rate_limit: {
        primary_window: window,
        secondary_window: {
          ...window,
          limit_window_seconds: 604_800,
          used_percent: 62,
        },
      },
    }),
  );
  const quota = createOpenCodeChatGptQuota(directory, request);
  const [first, concurrent] = await Promise.all([
    quota("first"),
    quota("first"),
  ]);
  expect(first).toEqual([
    {
      name: "ChatGPT 5-hour",
      usedPercent: 100,
      exhausted: true,
      resetsAt: 2_000_000_000_000,
    },
    {
      name: "ChatGPT weekly",
      usedPercent: 62,
      exhausted: false,
      resetsAt: 2_000_000_000_000,
    },
  ]);
  expect(concurrent).toEqual(first);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "https://chatgpt.com/backend-api/wham/usage",
    {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer fixture-access",
        "ChatGPT-Account-Id": "fixture-account",
      },
      redirect: "error",
      signal: expect.any(AbortSignal),
    },
  );
  clock.mockReturnValue(now + 31_000);
  await quota("first");
  expect(request).toHaveBeenCalledTimes(2);
  save("second", { access: "replacement" });
  expect(await quota("first")).toEqual([]);
  await quota("second");
  expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.lastCall?.[1]?.headers).toMatchObject({
    Authorization: "Bearer replacement",
  });
});

it("keeps a valid single window when the other window is invalid", async () => {
  save("device", { accountID: undefined });
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({
      rate_limit: {
        primary_window: { ...window, used_percent: -1 },
        secondary_window: {
          ...window,
          limit_window_seconds: 3_600,
          used_percent: 25,
        },
      },
    }),
  );
  const quota = createOpenCodeChatGptQuota(directory, request);
  expect(await quota("device")).toEqual([
    {
      name: "ChatGPT secondary",
      usedPercent: 25,
      exhausted: false,
      resetsAt: 2_000_000_000_000,
    },
  ]);
  expect(request.mock.lastCall?.[1]?.headers).not.toHaveProperty(
    "ChatGPT-Account-Id",
  );
});

it.each([
  { expires: 1 },
  { methodID: "chatgpt-token-sharing" },
  { type: "key" },
])("skips unsupported credentials (%j)", async (fields) => {
  save("active", fields);
  const request = vi.fn<typeof fetch>();
  expect(
    await createOpenCodeChatGptQuota(directory, request)("active"),
  ).toEqual([]);
  expect(request).not.toHaveBeenCalled();
});

it.each([
  () => new Response(null, { status: 401 }),
  () => new Response("invalid JSON"),
  () => Response.json({ rate_limit: null }),
  () => {
    throw new DOMException("Timed out", "TimeoutError");
  },
])(
  "returns unavailable data when the usage request fails",
  async (response) => {
    save("active");
    const quota = createOpenCodeChatGptQuota(directory, async () => response());
    expect(await quota("active")).toEqual([]);
  },
);
