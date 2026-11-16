import type { PanelDeps } from "./panel.js";

/** Browser-safe metadata. These imports are erased; no server runtime is bundled. */
export type AgentSummary = NonNullable<
  ReturnType<NonNullable<PanelDeps["getAgentSetup"]>>
> & { id: string };
export interface PanelSession {
  authenticated: true;
  capabilities: { createAgent: boolean };
}
export interface AgentDetail extends AgentSummary {
  discord?: {
    connection: { botId: string; botUsername: string; ownerId: string } | null;
  };
  settings?: { name: string; instructions: string };
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
