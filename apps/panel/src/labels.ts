import type {
  AgentDetail,
  AgentSummary,
} from "../../server/src/panel-contracts.js";

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
