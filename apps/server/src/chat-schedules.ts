import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ServerToolHandler } from "./tool-dispatch.js";
import type { RoutedTask } from "./task-queue.js";
import {
  SCHEDULE_LIMITS,
  ScheduleValidationError,
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

function describeCadence(cadence: ScheduleInput["cadence"]) {
  switch (cadence.kind) {
    case "once":
      return `Once on ${cadence.date} at ${cadence.time}`;
    case "daily":
      return `Daily at ${cadence.time}`;
    case "weekly":
      return `Every ${cadence.weekdays.map((day) => weekdays[day]).join(", ")} at ${cadence.time}`;
    case "interval":
      return `Every ${cadence.minutes} minutes`;
    case "webhook":
      return "On webhook request";
  }
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
  ): Promise<void>;
  now?: () => number;
}) {
  const now = config.now ?? Date.now;
  type Draft = {
    key: string;
    origin: ScheduleOrigin;
    input: ScheduleInput & { agentId: string };
    nextRunAt: number | null;
    expiresAt: number;
  };
  let pending: Draft | undefined;

  function eligible(task: RoutedTask) {
    return (
      task.agentId === config.agentId &&
      task.origin.platform === "telegram" &&
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
        if (task.origin.platform !== "telegram" || !eligible(task))
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
          prompt,
          timeZone,
          cadence:
            cadence.kind === "interval"
              ? { ...cadence, anchor: now() }
              : cadence,
        };
        try {
          const { data, next } = config.store.preview(input);
          const draft = {
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
          const text = [
            `Create schedule "${data.name}"?`,
            `Frequency: ${describeCadence(data.cadence)}`,
            `Time zone: ${timeZone}`,
            `First run: ${firstRun}`,
            `\nTask:\n${data.prompt}`,
          ].join("\n");
          signal.throwIfAborted();
          pending = draft;
          try {
            await config.send(task.origin, text, draft.key, signal);
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
    answer(key: string, confirm: boolean, origin: ScheduleOrigin) {
      const draft = pending;
      if (
        !draft ||
        key !== draft.key ||
        origin.botId !== draft.origin.botId ||
        origin.chatId !== draft.origin.chatId ||
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
