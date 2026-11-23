import type { PanelDeps } from "./panel.js";
import type {
  Schedule,
  ScheduleRun,
  SCHEDULE_LIMITS,
} from "../schedules/schedule-store.js";
import type { ScheduleCadence } from "../schedules/schedule-time.js";
export type { Schedule, ScheduleRun } from "../schedules/schedule-store.js";
export type { ScheduleRunNowResult } from "../schedules/scheduler.js";
export type {
  ProviderSettings,
  DeviceLogin,
} from "../providers/provider-contracts.js";
export type {
  ExecutionDetail,
  ExecutionEntry,
  ExecutionPage,
} from "../tasks/execution-history.js";
export type { DelegationHistoryEntry } from "../tasks/task-queue.js";
export type DelegationHistory = ReturnType<
  import("../tasks/task-queue.js").TaskStore["listDelegations"]
>;
export type { McpDefinition } from "../mcp/mcp-catalog.js";
export type { McpDiscoveryResult } from "../mcp/mcp-discovery.js";
export type { McpExample } from "../mcp/mcp-examples.js";
export type McpDefinitionSummary = Pick<
  import("../mcp/mcp-catalog.js").McpDefinition,
  "id" | "label" | "enabled" | "revision" | "blockedTools"
>;
export interface McpCatalogList {
  definitions: McpDefinitionSummary[];
  examples: readonly import("../mcp/mcp-examples.js").McpExample[];
}
export interface McpAgentDefinition extends McpDefinitionSummary {
  granted: boolean;
  hasCredential: boolean;
}

export interface ScheduleSettings {
  deliveryChannel: Schedule["deliveryChannel"];
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
  discordOwnerLinked: boolean;
  defaultTimeZone: string;
}

export interface ScheduleDefaults {
  timeZone: string;
}

/** Browser-safe metadata. These imports are erased; no server runtime is bundled. */
export type AgentSummary = NonNullable<
  ReturnType<NonNullable<PanelDeps["getAgentSetup"]>>
> & { id: string };
export interface PanelSession {
  authenticated: true;
  deploymentMode: "native" | "docker";
  capabilities: {
    providers?: boolean;
    createAgent: boolean;
    mcp?: boolean;
    scheduleSettings?: boolean;
    executions?: boolean;
  };
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
  providerChecks?: import("../providers/provider-contracts.js").ProviderCheck[];
  hostState?: "ready" | "busy" | "unavailable";
  capabilities: {
    edit: boolean;
    connectTelegram?: boolean;
    replaceToken: boolean;
    process?: { start: boolean; stop: boolean; restart: boolean };
    delete: boolean;
  };
}
export interface AgentDirectoryEntry extends AgentSummary {
  discord?: {
    connection: { botUsername: string } | null;
    conversation?: DiscordConversationStatus;
  };
  optionCapabilities: {
    edit: boolean;
    discord: boolean;
    memoryTools: boolean;
  };
}
export interface PanelStatus {
  agents: AgentDirectoryEntry[];
}
