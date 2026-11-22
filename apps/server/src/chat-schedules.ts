import { randomBytes } from "node:crypto";
import { z } from "zod";
import { nextRuns } from "./schedule-time.js";
import type { ServerToolHandler } from "./tasks/tool-dispatch.js";
import type { RoutedTask } from "./tasks/task-queue.js";
import {
  SCHEDULE_LIMITS,
  ScheduleValidationError,
  type Schedule,
  type ScheduleInput,
  type ScheduleOrigin,
  type ScheduleStore,
} from "./schedule-store.js";

const CONTEXT = "schedule.context";
const PROPOSE = "schedule.propose";
const TTL_MS = 10 * 60_000;
const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const proposal = z.strictObject({
  name: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxNameLength),
  prompt: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxPromptLength),
  timeZone: z.string(),
  cadence: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("once"),
      date: z.string(),
      time: z.string(),
    }),
    z.strictObject({ kind: z.literal("daily"), time: z.string() }),
    z.strictObject({
      kind: z.literal("weekly"),
      time: z.string(),
      weekdays: z.array(z.number()).max(7),
    }),
    z.strictObject({ kind: z.literal("interval"), minutes: z.number() }),
    z.strictObject({
      kind: z.literal("cron"),
      expression: z.string().max(SCHEDULE_LIMITS.maxCronExpressionLength),
    }),
  ]),
});

function formatRun(at: number, timeZone: string) {
  const date = new Intl.DateTimeFormat("en", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(at);
  return `${date} (${timeZone})`;
}

function describeCadence(cadence: ScheduleInput["cadence"], timeZone: string) {
  switch (cadence.kind) {
    case "once":
      return `Once on ${cadence.date} at ${cadence.time}`;
    case "daily":
      return `Daily at ${cadence.time}`;
    case "weekly":
      return `Every ${cadence.weekdays.map((day) => weekdays[day]).join(", ")} at ${cadence.time}`;
    case "interval":
      return `Every ${cadence.minutes} minutes`;
    case "cron":
      return `Cron ${cadence.expression} (${timeZone})`;
    case "webhook":
      return "On webhook request";
  }
}

export type ListedSchedule = Pick<
  Schedule,
  "name" | "enabled" | "nextRunAt" | "timeZone"
> &
  Partial<Pick<Schedule, "deliveryChannel">> & {
    cadence: Pick<Schedule["cadence"], "kind">;
  };

export function formatScheduleList(
  schedules: ListedSchedule[],
  agentName: string,
  manage: string,
) {
  if (!schedules.length) return `No schedules for ${agentName}. ${manage}`;
  const rows = schedules.map((schedule) => {
    const state = `${schedule.name} — ${schedule.enabled ? "Enabled" : "Disabled"}`;
    const channel =
      schedule.deliveryChannel === "discord" ? "Discord" : "Telegram";
    const next =
      schedule.cadence.kind === "webhook"
        ? "Runs on webhook request"
        : schedule.nextRunAt === null
          ? `Next run: No upcoming run (${schedule.timeZone})`
          : `Next run: ${formatRun(schedule.nextRunAt, schedule.timeZone)}`;
    return `${state}\n${next}\nDelivery via ${channel}`;
  });
  return `Schedules for ${agentName}:\n\n${rows.join("\n\n")}\n\n${manage}`;
}

export function createChatSchedules(config: {
  agentId: string;
  store: Pick<ScheduleStore, "getDefaultTimeZone" | "preview" | "create">;
  canReach(origin: ScheduleOrigin): boolean;
  send(
    origin: ScheduleOrigin,
    text: string,
    key: string,
    signal: AbortSignal,
  ): Promise<string | void>;
  now?: () => number;
}) {
  const now = config.now ?? Date.now;
  type Draft = {
    key: string;
    origin: ScheduleOrigin;
    input: ScheduleInput & { agentId: string };
    nextRunAt: number | null;
    expiresAt: number;
    messageId?: string;
  };
  let pending: Draft | undefined;

  function eligible(task: RoutedTask) {
    return (
      task.agentId === config.agentId &&
      task.origin.platform !== "delegated" &&
      task.scheduleId === undefined &&
      config.canReach(task.origin)
    );
  }

  const handlers: ServerToolHandler[] = [
    {
      operation: CONTEXT,
      write: false,
      validate: (args) => z.strictObject({}).safeParse(args).data,
      authorize: eligible,
      async execute() {
        const timeZone = config.store.getDefaultTimeZone();
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).formatToParts(now());
        const { year, month, day, hour, minute } = Object.fromEntries(
          parts.map(({ type, value }) => [type, value]),
        );
        return {
          timeZone,
          localDate: `${year}-${month}-${day}`,
          localTime: `${hour}:${minute}`,
        };
      },
    },
    {
      operation: PROPOSE,
      write: true,
      validate: (args) => proposal.safeParse(args).data,
      authorize: eligible,
      async execute(task, args, { signal }) {
        if (task.origin.platform === "delegated" || !eligible(task))
          throw new Error("Schedule proposals are unavailable");
        const { name, prompt, cadence, timeZone } = proposal.parse(args);
        if (timeZone !== config.store.getDefaultTimeZone())
          return {
            status: "invalid",
            message:
              "Use the current schedule time zone from the panel. Read the schedule context again.",
          };
        const input = {
          agentId: config.agentId,
          name,
          deliveryChannel: task.origin.platform,
          prompt,
          timeZone,
          cadence:
            cadence.kind === "interval"
              ? { ...cadence, anchor: now() }
              : cadence,
        };
        try {
          const { data, next } = config.store.preview(input);
          const draft: Draft = {
            key: randomBytes(12).toString("base64url"),
            origin: task.origin,
            input: { ...data, agentId: config.agentId },
            nextRunAt: cadence.kind === "interval" ? null : next,
            expiresAt: now() + TTL_MS,
          };
          const firstRun =
            cadence.kind === "interval"
              ? `${cadence.minutes} minutes after confirmation`
              : formatRun(next!, timeZone);
          const additionalRuns =
            data.cadence.kind === "cron"
              ? nextRuns(data.cadence, timeZone, next!, 3).map((run) =>
                  formatRun(run, timeZone),
                )
              : [];
          const text = [
            `Create schedule "${data.name}"?`,
            `Frequency: ${describeCadence(data.cadence, timeZone)}`,
            `Time zone: ${timeZone}`,
            `First run: ${firstRun}`,
            ...(additionalRuns.length ? ["Next runs:", ...additionalRuns] : []),
            `\nTask:\n${data.prompt}`,
          ].join("\n");
          signal.throwIfAborted();
          pending = draft;
          try {
            const messageId = await config.send(
              task.origin,
              text,
              draft.key,
              signal,
            );
            if (typeof messageId === "string") draft.messageId = messageId;
          } catch (error) {
            if (pending === draft) pending = undefined;
            throw error;
          }
          return { status: "awaiting_confirmation", timeZone };
        } catch (error) {
          if (error instanceof ScheduleValidationError)
            return { status: "invalid", message: error.message };
          throw error;
        }
      },
    },
  ];

  return {
    handlers,
    operations: (task: RoutedTask) =>
      eligible(task) ? [CONTEXT, PROPOSE] : [],
    answer(
      key: string,
      confirm: boolean,
      origin: ScheduleOrigin,
      messageId?: string,
    ) {
      const draft = pending;
      if (
        !draft ||
        key !== draft.key ||
        origin.platform !== draft.origin.platform ||
        origin.botId !== draft.origin.botId ||
        (origin.platform === "telegram"
          ? draft.origin.platform !== "telegram" ||
            origin.chatId !== draft.origin.chatId
          : draft.origin.platform !== "discord" ||
            origin.ownerId !== draft.origin.ownerId ||
            origin.channelId !== draft.origin.channelId ||
            !messageId ||
            messageId !== draft.messageId) ||
        !config.canReach(origin)
      )
        return "This schedule proposal has expired or was already answered.";
      pending = undefined;
      if (draft.expiresAt <= now())
        return "This schedule proposal has expired. Ask for the schedule again.";
      if (!confirm) return "Schedule creation cancelled.";
      try {
        const schedule = config.store.create(draft.input, {
          nextRunAt: draft.nextRunAt,
        });
        return `Schedule "${schedule.name}" created. First run: ${formatRun(schedule.nextRunAt!, schedule.timeZone)}.`;
      } catch (error) {
        if (error instanceof ScheduleValidationError) return error.message;
        return "I could not confirm that the schedule was saved. Check /schedules before retrying.";
      }
    },
    clear() {
      pending = undefined;
    },
  };
}
