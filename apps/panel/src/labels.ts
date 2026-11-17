import type {
  AgentDetail,
  AgentSummary,
  Schedule,
  ScheduleRun,
} from "../../server/src/panel-contracts.js";
import { nextRun } from "../../server/src/schedule-time.js";

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
  kind: "Cadence",
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
    "Every run uses this agent's AI provider credits. Results arrive in the owner's private Telegram chat.",
  unlinked:
    "Owner chat is not linked. The owner must send this agent's Telegram bot a private message. Runs are skipped until the chat is linked.",
  rules:
    "Stopped or unavailable agents are skipped; containers never start automatically. Runs more than 10 minutes late are missed, and overlapping runs are skipped.",
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
  pausedHelp: "Pausing stops timed runs. You can still use Run now.",
  saved: "Schedule saved.",
  removed: "Schedule deleted. Already queued or running tasks are kept.",
  pauseDone: "Schedule paused.",
  resumeDone: "Schedule resumed.",
  expired:
    "This schedule has no future occurrence. Edit its date before resuming.",
  confirm: (name: string) =>
    `Delete schedule "${name}" and its run history? Already queued or running tasks are kept.`,
  outcomes: {
    enqueued:
      "Task queued. Its result will arrive in the owner's Telegram chat.",
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
    case "once":
      return `Once on ${cadence.date} at ${cadence.time}`;
    case "daily":
      return `Daily at ${cadence.time}`;
    case "weekly":
      return `Every ${cadence.weekdays.map((day) => scheduleWeekdays[day]).join(", ")} at ${cadence.time}`;
    case "interval":
      return `Every ${cadence.minutes} minutes`;
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
export const setupLabels: Record<string, string> = {
  pending: "Pending",
  provisioning: "In progress",
  ready: "Completed",
  failed: "Failed; created resources are kept for review",
  interrupted: "Interrupted by a server restart; needs review",
  cancelled: "Cancelled; created resources are kept for review",
};
export const failureLabels = {
  setup_incomplete: "Complete agent provisioning before connecting this bot.",
  credentials_unavailable:
    "Saved bot or Agent Host credentials are unavailable.",
  identity_mismatch:
    "The token does not match this agent's registered bot or owner.",
  invalid_token:
    "Telegram rejected the bot token. Replace it and restart the server.",
  telegram_unavailable:
    "Telegram polling could not continue. Check connectivity and whether another instance is polling this bot.",
};
export function botLabel(agent: AgentSummary) {
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
export function stopMessage(observation: AgentDetail["stopObservation"]) {
  if (!observation) return "";
  if (observation.availability === "unavailable")
    return "Could not check whether a task was active before stopping the container. There is no confirmed result.";
  if (!observation.hadTask)
    return "No task was active when the agent was checked before stopping the container.";
  if (!observation.finalStatus)
    return "A task was active. Result unconfirmed: start the container and refresh the status to check that task's record.";
  return {
    interrupted: "Task interrupted.",
    completed: "The task finished before an interruption was confirmed.",
    failed: "The task finished with an error.",
  }[observation.finalStatus];
}
