import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createChatSchedules } from "./chat-schedules.js";
import { openScheduleStore, type ScheduleOrigin } from "./schedule-store.js";
import type { ChatTask } from "./tasks/task-queue.js";

const origin = { platform: "telegram", botId: 123, chatId: 42 } as const;
const task: ChatTask = {
  id: "task",
  agentId: "dev",
  botId: 123,
  chatId: 42,
  prompt: "Schedule a review",
  origin,
};
const MINUTE = 60_000;
let now: number;
let store: ReturnType<typeof openScheduleStore>;
let service: ReturnType<typeof createChatSchedules>;
const send = vi.fn<
  (origin: ScheduleOrigin, text: string, key: string) => Promise<string | void>
>(async () => {});
let reachable: boolean;
beforeEach(() => {
  send.mockReset();
  now = Date.parse("2027-01-01T08:00:00Z");
  reachable = true;
  store = openScheduleStore(":memory:", { now: () => now });
  service = createChatSchedules({
    agentId: "dev",
    store,
    send,
    canReach: () => reachable,
    now: () => now,
  });
});
afterEach(() => store.close());

function propose(
  cadence: Record<string, unknown>,
  timeZone = store.getDefaultTimeZone(),
  source: ChatTask = task,
) {
  const handler = service.handlers.find(
    ({ operation }) => operation === "schedule.propose",
  )!;
  const args = handler.validate({
    name: "Review",
    prompt: "Send a reminder.",
    timeZone,
    cadence,
  });
  expect(args).toBeDefined();
  return handler.execute(source, args!, {
    invocationId: "test",
    signal: new AbortController().signal,
  });
}
function key() {
  return send.mock.lastCall![2];
}

it.each([
  [{ kind: "once", date: "2027-01-02", time: "09:00" }, "2027-01-02T09:00:00Z"],
  [{ kind: "daily", time: "09:00" }, "2027-01-01T09:00:00Z"],
  [{ kind: "weekly", weekdays: [1, 5], time: "09:00" }, "2027-01-01T09:00:00Z"],
  [{ kind: "interval", minutes: 15 }, "2027-01-01T08:16:00Z"],
])("has the correct first run for %j", async (cadence, firstRun) => {
  expect(await propose(cadence)).toMatchObject({
    status: "awaiting_confirmation",
  });
  expect(store.listByAgent("dev")).toEqual([]);
  now += MINUTE;
  expect(service.answer(key(), true, origin)).toContain(
    'Schedule "Review" created.',
  );
  expect(store.listByAgent("dev")).toMatchObject([
    { nextRunAt: Date.parse(firstRun) },
  ]);
});

it("previews the first valid local instant across a daylight saving gap", async () => {
  now = Date.parse("2027-03-14T06:00:00Z");
  store.setDefaultTimeZone("America/New_York");
  await propose({ kind: "daily", time: "02:30" });
  expect(send.mock.lastCall?.[1]).toContain("3:00 AM (America/New_York)");
  service.answer(key(), true, origin);
  expect(store.listByAgent("dev")[0]?.nextRunAt).toBe(
    Date.parse("2027-03-14T07:00:00Z"),
  );
});

it("rejects incomplete proposals, unsupported cadences and invalid intervals", async () => {
  const handler = service.handlers.find(
    ({ operation }) => operation === "schedule.propose",
  )!;
  const input = { name: "Review", prompt: "Send a reminder.", timeZone: "UTC" };
  expect(
    handler.validate({ ...input, cadence: { kind: "daily" } }),
  ).toBeUndefined();
  expect(
    handler.validate({ ...input, cadence: { kind: "webhook" } }),
  ).toBeUndefined();
  expect(await propose({ kind: "interval", minutes: 14 })).toMatchObject({
    status: "invalid",
    message: expect.stringContaining("at least 15 minutes"),
  });
  expect(
    await propose({ kind: "interval", minutes: 15 }, "Europe/Madrid"),
  ).toMatchObject({
    status: "invalid",
    message: expect.stringContaining("current schedule time zone"),
  });
  expect(send).not.toHaveBeenCalled();
});

it("only grants schedule tools to reachable interactive chat tasks", () => {
  expect(service.operations(task)).toEqual([
    "schedule.context",
    "schedule.propose",
  ]);
  expect(service.operations({ ...task, agentId: "other" })).toEqual([]);
  expect(service.operations({ ...task, scheduleId: "schedule" })).toEqual([]);
  expect(
    service.operations({
      id: "delegated",
      agentId: "dev",
      prompt: "Schedule",
      origin: {
        platform: "delegated",
        delegationId: "d",
        sourceAgentId: "other",
        parentTaskId: "p",
      },
    }),
  ).toEqual([]);
  expect(
    service.operations({
      id: "discord",
      agentId: "dev",
      prompt: "Schedule",
      origin: {
        platform: "discord",
        botId: "1",
        ownerId: "2",
        channelId: "3",
        messageId: "4",
      },
    }),
  ).toEqual(["schedule.context", "schedule.propose"]);
  reachable = false;
  expect(service.operations(task)).toEqual([]);
});

it("checks the chat and bot and ignores replaced, cancelled and expired drafts", async () => {
  const cadence = { kind: "daily", time: "09:00" };
  await propose(cadence);
  const replaced = key();
  await propose(cadence);
  const current = key();
  expect(service.answer(replaced, true, origin)).toContain("expired");
  expect(service.answer(current, true, { ...origin, botId: 999 })).toContain(
    "expired",
  );
  expect(service.answer(current, true, { ...origin, chatId: 999 })).toContain(
    "expired",
  );
  reachable = false;
  expect(service.answer(current, true, origin)).toContain("expired");
  reachable = true;
  expect(service.answer(current, false, origin)).toContain("cancelled");
  expect(service.answer(current, true, origin)).toContain("expired");
  await propose(cadence);
  now += 10 * MINUTE;
  expect(service.answer(key(), true, origin)).toContain("expired");
  expect(store.listByAgent("dev")).toEqual([]);
});

it("requires a fresh confirmation after the time zone changes or first occurrence passes", async () => {
  await propose({ kind: "daily", time: "08:01" });
  now += MINUTE;
  expect(service.answer(key(), true, origin)).toContain(
    "first run time has passed",
  );
  await propose({ kind: "daily", time: "09:00" });
  store.setDefaultTimeZone("Europe/Madrid");
  expect(service.answer(key(), true, origin)).toContain("time zone changed");
  expect(store.listByAgent("dev")).toEqual([]);
});

it("expires a draft whose Telegram preview could not be sent", async () => {
  send.mockRejectedValueOnce(new Error("Telegram unavailable"));
  await expect(propose({ kind: "daily", time: "09:00" })).rejects.toThrow(
    "Telegram unavailable",
  );
  expect(service.answer(key(), true, origin)).toContain("expired");
  expect(store.listByAgent("dev")).toEqual([]);
});

it("confirms a Discord proposal once from the same owner, DM and message", async () => {
  const discord = {
    platform: "discord",
    botId: "11",
    ownerId: "22",
    channelId: "33",
  } as const;
  send.mockResolvedValue("44");
  const source = {
    id: "d",
    agentId: "dev",
    prompt: "Schedule a review",
    origin: discord,
  };
  const cadence = { kind: "daily", time: "09:00" };
  await propose(cadence, "UTC", source);
  expect(
    service.answer(key(), true, { ...discord, ownerId: "55" }, "44"),
  ).toContain("expired");
  expect(service.answer(key(), true, discord, "55")).toContain("expired");
  expect(store.listByAgent("dev")).toEqual([]);
  expect(service.answer(key(), true, discord, "44")).toContain(
    'Schedule "Review" created.',
  );
  expect(service.answer(key(), true, discord, "44")).toContain(
    "already answered",
  );
  expect(store.listByAgent("dev")).toMatchObject([
    { deliveryChannel: "discord" },
  ]);
  await propose(cadence, "UTC", source);
  now += 10 * MINUTE;
  expect(service.answer(key(), true, discord, "44")).toContain("expired");
  expect(store.listByAgent("dev")).toHaveLength(1);
});

it("validates cron, previews four local runs and saves only on confirmation", async () => {
  expect(
    await propose({ kind: "cron", expression: "*/5 * * * *" }),
  ).toMatchObject({
    status: "invalid",
    message: "Cron minutes must be at least 15 minutes apart.",
  });
  expect(send).not.toHaveBeenCalled();
  const cadence = { kind: "cron", expression: "0 9 * * mon-fri" };
  expect(await propose(cadence)).toMatchObject({
    status: "awaiting_confirmation",
  });
  const preview = send.mock.lastCall![1];
  expect(preview).toContain("Cron 0 9 * * MON-FRI (UTC)");
  expect(preview.match(/9:00 AM \(UTC\)/g)).toHaveLength(4);
  expect(store.listByAgent("dev")).toEqual([]);
  expect(service.answer(key(), true, origin)).toContain(
    'Schedule "Review" created.',
  );
  expect(store.listByAgent("dev")).toMatchObject([
    {
      cadence: { ...cadence, expression: "0 9 * * MON-FRI" },
      nextRunAt: now + 60 * MINUTE,
    },
  ]);
});
