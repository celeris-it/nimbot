import type { PanelDeps } from "./panel.js";
import type {
  Schedule,
  ScheduleRun,
  SCHEDULE_LIMITS,
} from "./schedule-store.js";
import type { ScheduleCadence } from "./schedule-time.js";
export type { Schedule, ScheduleRun } from "./schedule-store.js";
export type { ScheduleRunNowResult } from "./scheduler.js";
export type { ProviderSettings, DeviceLogin } from "./provider-contracts.js";
export type { DelegationHistoryEntry } from "./task-queue.js";
export type DelegationHistory = ReturnType<
  import("./task-queue.js").TaskStore["listDelegations"]
>;
export type { McpDefinition } from "./mcp-catalog.js";
export type { McpDiscoveryResult } from "./mcp-discovery.js";
export type McpDefinitionSummary = Pick<
  import("./mcp-catalog.js").McpDefinition,
  "id" | "label" | "enabled" | "revision"
>;
export interface McpAgentDefinition extends McpDefinitionSummary {
  granted: boolean;
  hasCredential: boolean;
}

export interface ScheduleSettings {
  name: string;
  prompt: string;
  timeZone: string;
  cadence:
    | Exclude<ScheduleCadence, { kind: "interval" }>
    | { kind: "interval"; minutes: number };
}
export interface ScheduleList {
  schedules: (Schedule & {
    lastRun: ScheduleRun | null;
    recentRuns: ScheduleRun[];
  })[];
  limits: typeof SCHEDULE_LIMITS;
  ownerLinked: boolean;
}

/** Browser-safe metadata. These imports are erased; no server runtime is bundled. */
export type AgentSummary = NonNullable<
  ReturnType<NonNullable<PanelDeps["getAgentSetup"]>>
> & { id: string };
export interface PanelSession {
  authenticated: true;
  capabilities: { createAgent: boolean; mcp?: boolean };
}
export interface DiscordConversationStatus {
  state: "connecting" | "ready" | "reconnecting" | "failed" | "stopped";
  ownerLinked: boolean;
}
export interface AgentDetail extends AgentSummary {
  discord?: {
    conversation?: DiscordConversationStatus;
    connection: { botId: string; botUsername: string; ownerId: string } | null;
  };
  settings?: { name: string; instructions: string };
  /** Present when the memory tools can be switched for this agent. */
  memoryEnabled?: boolean;
  containerState?: "running" | "stopped" | "missing" | "unavailable";
  hostState?: "ready" | "busy" | "unavailable";
  stopObservation?: {
    availability: "available" | "unavailable";
    hadTask: boolean;
    observedAt: number;
    finalStatus: "completed" | "failed" | "interrupted" | null;
  };
  capabilities: {
    edit: boolean;
    replaceToken: boolean;
    container: boolean;
    cancel: boolean;
    retry: boolean;
    delete: boolean;
  };
}
export interface PanelStatus {
  agents: AgentSummary[];
}
