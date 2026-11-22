import type {
  AgentSummary,
  Schedule,
  ScheduleRun,
} from "../../server/src/panel/panel-contracts.js";
import { nextRun } from "../../server/src/schedules/schedule-time.js";

export const scheduleText = {
  title: (name: string) => `Schedules for ${name}`,
  pageTitle: "Schedules",
  link: "Manage schedules",
  back: "Back to agent",
  new: "New schedule",
  create: "Create schedule",
  edit: "Edit",
  editTitle: "Edit schedule",
  save: "Save schedule",
  saving: "Saving…",
  cancel: "Cancel",
  pause: "Pause",
  resume: "Resume",
  run: "Run now",
  remove: "Delete",
  refresh: "Refresh schedules",
  name: "Schedule name",
  prompt: "Prompt",
  kind: "Activation",
  date: "Date",
  time: "Time of day",
  minutes: "Interval in minutes",
  zone: "Time zone",
  weekdays: "Weekdays",
  next: "Next run",
  last: "Last run",
  history: "Recent runs",
  none: "No schedules yet. Create one to run a saved prompt automatically.",
  noRuns: "No runs yet",
  noNext: "Not scheduled",
  enabled: "Enabled",
  paused: "Paused",
  finished: "Finished",
  count: (count: number, max: number) => `${count} of ${max} schedules`,
  limit: "Schedule limit reached. Delete a schedule to create another.",
  costs:
    "Every run uses this agent's AI provider credits. Results arrive in the owner's private chat on the selected channel.",
  rules:
    "Stopped or unavailable agents are skipped; schedules never start agents automatically. Runs more than 10 minutes late are missed, and overlapping timed or manual runs are skipped. Webhook requests queue instead.",
  promptHelp:
    "Describe what the agent should do. Scheduled runs share its existing conversation context.",
  zoneHelp:
    "Use an IANA time zone, for example Europe/Madrid. Dates and times use this zone.",
  zoneError: "Enter a valid IANA time zone, for example Europe/Madrid.",
  weekdayError: "Select at least one weekday.",
  intervalHelp: (min: number) =>
    `At least ${min} minutes. Intervals stay anchored to creation time.`,
  dateHelp: "Choose a future local date and time.",
  dstHelp:
    "A time skipped by daylight saving runs at the next valid instant; a repeated time runs only once.",
  editHelp:
    "Changes apply to future tasks. Already queued or running tasks keep their saved prompt and name.",
  pausedHelp:
    "Pausing stops timed and webhook runs. You can still use Run now.",
  webhookWaiting: "Waiting for webhook",
  webhookFormHelp:
    "Save this schedule to get its webhook URL and token. An optional JSON payload is appended to the prompt. Pausing blocks webhook requests.",
  webhookShow: "Show webhook details",
  webhookHide: "Hide webhook details",
  webhookUrl: "Webhook URL",
  webhookToken: "Bearer token",
  webhookRotate: "Regenerate token",
  webhookRotateConfirm:
    "Regenerate this webhook token? The previous token will stop working immediately.",
  webhookHelp:
    "Send a POST request with Authorization: Bearer TOKEN. Keep the token private. Optional body: application/json, up to 16 KiB. Limit: five requests per minute. Requests received while a run is in progress are queued, up to 20 unfinished runs.",
  cronHelp:
    "Five fields in the schedule time zone: minute hour day-of-month month day-of-week. Minutes must be at least 15 minutes apart.",
  cronNextRuns: "Next runs",
  webhookError: "Could not load webhook details.",
  saved: "Schedule saved.",
  removed: "Schedule deleted. Already queued or running tasks are kept.",
  pauseDone: "Schedule paused.",
  resumeDone: "Schedule resumed.",
  expired:
    "This schedule has no future occurrence. Edit its date before resuming.",
  confirm: (name: string) =>
    `Delete schedule "${name}" and its run history? Already queued or running tasks are kept.`,
  outcomes: {
    enqueued: "Task queued. Its result will arrive in the selected owner chat.",
    skipped_not_ready:
      "Not run: the agent is unavailable or its owner chat is not linked.",
    skipped_overlap:
      "Not run: a previous task from this schedule is still queued or running.",
  },
};
export const scheduleKinds = {
  once: "Once",
  daily: "Daily",
  weekly: "Weekly",
  interval: "Interval",
  cron: "Cron expression",
  webhook: "Webhook",
};
export const scheduleWeekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export function scheduleCadenceLabel(cadence: Schedule["cadence"]) {
  switch (cadence.kind) {
    case "webhook":
      return "On webhook request";
    case "once":
      return `Once on ${cadence.date} at ${cadence.time}`;
    case "daily":
      return `Daily at ${cadence.time}`;
    case "weekly":
      return `Every ${cadence.weekdays.map((day) => scheduleWeekdays[day]).join(", ")} at ${cadence.time}`;
    case "interval":
      return `Every ${cadence.minutes} minutes`;
    case "cron":
      return `Cron ${cadence.expression}`;
  }
}
export function scheduleTimeLabel(at: number, timeZone: string) {
  return `${new Intl.DateTimeFormat("en", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(at)} (${timeZone})`;
}
export function scheduleStateLabel(schedule: Schedule) {
  if (schedule.enabled) return scheduleText.enabled;
  return schedule.cadence.kind === "once" &&
    nextRun(schedule.cadence, schedule.timeZone, Date.now()) === undefined
    ? scheduleText.finished
    : scheduleText.paused;
}
export function scheduleRunLabel(run: ScheduleRun) {
  if (run.outcome !== "enqueued")
    return {
      skipped_overlap: "Skipped: previous run still queued or running",
      skipped_not_ready: "Skipped: agent unavailable or owner chat unlinked",
      missed: "Missed: more than 10 minutes late",
    }[run.outcome];
  return run.taskStatus
    ? {
        queued: "Queued",
        running: "Running",
        completed: "Completed",
        failed: "Failed",
        interrupted: "Interrupted",
        cancelled: "Cancelled",
      }[run.taskStatus]
    : "Task status unavailable";
}

export const connectionLabels = {
  not_started: "Not started",
  connecting: "Verifying credentials and starting polling",
  polling: "Polling started",
  blocked: "Blocked by incomplete setup",
  failed: "Connection failed",
  stopped: "Stopped",
};
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
};
export function botLabel(agent: AgentSummary) {
  if (!agent.botUsername) return "Not configured";
  return agent.botConnection
    ? connectionLabels[agent.botConnection.status]
    : "Not connected yet";
}
export const botAccessLabels = {
  linked: "Bot verified and linked",
  unlinked: "Bot not linked",
  unavailable: "Unavailable",
};
export const ownerLabels = {
  pending: "Pending: waiting for the owner’s first message",
  verified: "Verified through a private message",
  unavailable: "Unavailable",
};
export const processLabels = {
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
};
