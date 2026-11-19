import type { TaskIdentity, TaskToolAccess } from "./task-identity.js";
import type {
  ModelReference,
  TaskUsage,
  UsageReading,
} from "./engine-usage.js";

/** Runtime identity and optional tool access stay separate from the model's prompt. */
export interface EngineTaskContext {
  hostTaskId: string;
  identity?: TaskIdentity;
  tools?: TaskToolAccess;
  /** A separate conversation that must never read or replace the saved owner session. */
  sessionMode?: "fresh";
  model?: ModelReference;
  recordUsageBaseline?: (reading: UsageReading) => Promise<void>;
  recordUsage?: (usage: TaskUsage) => Promise<void>;
  /** Host outbox transport; the receiving Server must enforce its own authorization. */
  requestTool?: (
    operation: string,
    args: Record<string, unknown>,
    invocationId: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

/** Engine boundary: no Telegram or HTTP concerns. */
export interface Engine {
  /**
   * `onProgress` receives short, human-readable steps such as tool use.
   * `requestApproval` asks a person to allow one sensitive action described by
   * `title`; without it, or on any failure, the action is denied.
   */
  run(
    prompt: string,
    onText: (text: string) => void,
    onProgress?: (message: string) => void,
    requestApproval?: (title: string) => Promise<boolean>,
    context?: EngineTaskContext,
  ): Promise<string>;
  stop(): Promise<void>;
}
