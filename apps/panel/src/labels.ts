import type { Translate, MessageKey } from "./i18n/language.js";
import type {
  AgentSummary,
  DiscordConversationStatus,
  Schedule,
  ScheduleRun,
} from "../../server/src/panel/panel-contracts.js";
import { nextRun } from "../../server/src/schedules/schedule-time.js";

export const discordConversationLabels = {
  connecting: "Connecting",
  ready: "Connected",
  reconnecting: "Reconnecting",
  failed: "Connection failed",
  stopped: "Disconnected",
} as const satisfies Record<DiscordConversationStatus["state"], MessageKey>;

export const scheduleText = (t: Translate) => ({
  title: (name: string) => t("Schedules for {0}", name),
  pageTitle: t("Schedules"),
  link: t("Schedules"),
  back: t("Back to agent"),
  new: t("New schedule"),
  create: t("Create schedule"),
  edit: t("Edit"),
  editTitle: t("Edit schedule"),
  save: t("Save schedule"),
  saving: t("Saving…"),
  cancel: t("Cancel"),
  pause: t("Pause"),
  resume: t("Resume"),
  run: t("Run now"),
  remove: t("Delete"),
  refresh: t("Refresh schedules"),
  name: t("Schedule name"),
  prompt: t("Prompt"),
  kind: t("Activation"),
  date: t("Date"),
  time: t("Time of day"),
  minutes: t("Interval in minutes"),
  zone: t("Time zone"),
  weekdays: t("Weekdays"),
  next: t("Next run"),
  last: t("Last run"),
  history: t("Recent runs"),
  none: t("No schedules yet. Create one to run a saved prompt automatically."),
  noRuns: t("No runs yet"),
  noNext: t("Not scheduled"),
  enabled: t("Enabled"),
  paused: t("Paused"),
  finished: t("Finished"),
  count: (count: number, max: number) => t("{0} of {1} schedules", count, max),
  limit: t("Schedule limit reached. Delete a schedule to create another."),
  costs: t(
    "Every run uses this agent's AI provider credits. Results arrive in the owner's private chat on the selected channel.",
  ),
  rules: t(
    "Stopped or unavailable agents are skipped; schedules never start agents automatically. Runs more than 10 minutes late are missed, and overlapping timed or manual runs are skipped. Webhook requests queue instead.",
  ),
  promptHelp: t(
    "Describe what the agent should do. Scheduled runs share its existing conversation context.",
  ),
  zoneHelp: t(
    "Use an IANA time zone, for example Europe/Madrid. Dates and times use this zone.",
  ),
  zoneError: t("Enter a valid IANA time zone, for example Europe/Madrid."),
  weekdayError: t("Select at least one weekday."),
  intervalHelp: (min: number) =>
    t("At least {0} minutes. Intervals stay anchored to creation time.", min),
  dateHelp: t("Choose a future local date and time."),
  dstHelp: t(
    "A time skipped by daylight saving runs at the next valid instant; a repeated time runs only once.",
  ),
  editHelp: t(
    "Changes apply to future tasks. Already queued or running tasks keep their saved prompt and name.",
  ),
  pausedHelp: t(
    "Pausing stops timed and webhook runs. You can still use Run now.",
  ),
  webhookWaiting: t("Waiting for webhook"),
  webhookFormHelp: t(
    "Save this schedule to get its webhook URL and token. An optional JSON payload is appended to the prompt. Pausing blocks webhook requests.",
  ),
  webhookShow: t("Show webhook details"),
  webhookHide: t("Hide webhook details"),
  webhookUrl: t("Webhook URL"),
  webhookToken: t("Bearer token"),
  webhookRotate: t("Regenerate token"),
  webhookRotateConfirm: t(
    "Regenerate this webhook token? The previous token will stop working immediately.",
  ),
  webhookHelp: t(
    "Send a POST request with Authorization: Bearer TOKEN. Keep the token private. Optional body: application/json, up to 16 KiB. Limit: five requests per minute. Requests received while a run is in progress are queued, up to 20 unfinished runs.",
  ),
  cronHelp: t(
    "Five fields in the schedule time zone: minute hour day-of-month month day-of-week. Minutes must be at least 15 minutes apart.",
  ),
  cronNextRuns: t("Next runs"),
  webhookError: t("Could not load webhook details."),
  saved: t("Schedule saved."),
  removed: t("Schedule deleted. Already queued or running tasks are kept."),
  pauseDone: t("Schedule paused."),
  resumeDone: t("Schedule resumed."),
  expired: t(
    "This schedule has no future occurrence. Edit its date before resuming.",
  ),
  confirm: (name: string) =>
    t(
      'Delete schedule "{0}" and its run history? Already queued or running tasks are kept.',
      name,
    ),
  outcomes: {
    enqueued: t(
      "Task queued. Its result will arrive in the selected owner chat.",
    ),
    skipped_not_ready: t(
      "Not run: the agent is unavailable or its owner chat is not linked.",
    ),
    skipped_overlap: t(
      "Not run: a previous task from this schedule is still queued or running.",
    ),
  },
});
export const scheduleKinds = {
  once: "Once",
  daily: "Daily",
  weekly: "Weekly",
  interval: "Interval",
  cron: "Cron expression",
  webhook: "Webhook",
} as const;
export const scheduleWeekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
export function scheduleCadenceLabel(
  t: Translate,
  cadence: Schedule["cadence"],
) {
  switch (cadence.kind) {
    case "webhook":
      return t("On webhook request");
    case "once":
      return t("Once on {0} at {1}", cadence.date, cadence.time);
    case "daily":
      return t("Daily at {0}", cadence.time);
    case "weekly":
      return t(
        "Every {0} at {1}",
        cadence.weekdays.map((day) => t(scheduleWeekdays[day]!)).join(", "),
        cadence.time,
      );
    case "interval":
      return t("Every {0} minutes", cadence.minutes);
    case "cron":
      return t("Cron {0}", cadence.expression);
  }
}
export function scheduleTimeLabel(
  locale: string,
  at: number,
  timeZone: string,
) {
  return `${new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "medium", timeStyle: "short" }).format(at)} (${timeZone})`;
}
export function scheduleStateLabel(t: Translate, schedule: Schedule) {
  if (schedule.enabled) return t("Enabled");
  return schedule.cadence.kind === "once" &&
    nextRun(schedule.cadence, schedule.timeZone, Date.now()) === undefined
    ? t("Finished")
    : t("Paused");
}
export function scheduleRunLabel(t: Translate, run: ScheduleRun) {
  if (run.outcome !== "enqueued")
    return {
      skipped_overlap: t("Skipped: previous run still queued or running"),
      skipped_not_ready: t("Skipped: agent unavailable or owner chat unlinked"),
      missed: t("Missed: more than 10 minutes late"),
    }[run.outcome];
  return run.taskStatus
    ? {
        queued: t("Queued"),
        running: t("Running"),
        completed: t("Completed"),
        failed: t("Failed"),
        interrupted: t("Interrupted"),
        cancelled: t("Cancelled"),
      }[run.taskStatus]
    : t("Task status unavailable");
}

export const connectionLabels = {
  not_started: "Not started",
  connecting: "Verifying credentials and starting polling",
  polling: "Polling started",
  blocked: "Blocked by incomplete setup",
  failed: "Connection failed",
  stopped: "Stopped",
} as const;
export const failureLabels = {
  setup_incomplete: "Start the Agent Host before connecting this bot.",
  credentials_unavailable:
    "Saved bot or Agent Host credentials are unavailable.",
  identity_mismatch:
    "The token does not match this agent's registered bot or owner.",
  invalid_token:
    "Telegram rejected the bot token. Replace it and restart the agent.",
  telegram_unavailable:
    "Telegram polling could not continue. Check connectivity and whether another instance is polling this bot.",
} as const;
export function botLabel(t: Translate, agent: AgentSummary) {
  if (!agent.botUsername) return t("Not configured");
  return agent.botConnection
    ? t(connectionLabels[agent.botConnection.status])
    : t("Not connected yet");
}
export const botAccessLabels = {
  linked: "Bot verified and linked",
  unlinked: "Bot not linked",
  unavailable: "Unavailable",
} as const;
export const ownerLabels = {
  pending: "Pending: waiting for the owner’s first message",
  verified: "Verified through a private message",
  unavailable: "Unavailable",
} as const;
export const processLabels = {
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
} as const;
