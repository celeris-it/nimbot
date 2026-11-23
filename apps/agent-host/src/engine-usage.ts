import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\p{Cc}]+$/u);
export const modelReference = z.strictObject({
  providerId: identifier,
  modelId: identifier,
});
export type ModelReference = z.infer<typeof modelReference>;
export const effortId = identifier.refine((value) => value !== "default");
export const modelSelection = modelReference.extend({
  effort: effortId.optional(),
});
export type ModelSelection = z.infer<typeof modelSelection>;

export const modelAdmission = z.strictObject({
  model: modelSelection,
  revision: z.uuid(),
});
export type ModelAdmission = z.infer<typeof modelAdmission>;

export interface UsageTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TaskUsage {
  model: ModelReference;
  tokens: UsageTokens | null;
  costUsd: number | null;
  state: "reported" | "partial" | "unavailable";
}

/** Engine-normalized snapshot persisted to recover interrupted turns. */
export interface UsageReading {
  session: string;
  model: ModelReference;
  priced: boolean;
  complete: boolean;
  counters: { id: string; tokens: UsageTokens; cost: number }[];
}

export interface ModelCheck {
  model: ModelReference | null;
  state:
    | "available"
    | "unavailable"
    | "exhausted"
    | "checking"
    | "model_unavailable"
    | "effort_unavailable";
  checkedAt: number;
  failure?:
    | "opencode_missing"
    | "opencode_start_failed"
    | "opencode_start_timeout"
    | "opencode_check_failed"
    | "quota_check_failed";
  windows: {
    name: string;
    usedPercent: number;
    exhausted: boolean;
    resetsAt: number;
    limitUsd?: number;
    spentUsd?: number;
  }[];
  admission?: ModelAdmission;
}

export interface EngineModels {
  list(): Promise<(ModelReference & { name: string; efforts: string[] })[]>;
  check(selected: ModelSelection | null, issue: boolean): Promise<ModelCheck>;
  accept(admission: ModelAdmission): boolean;
}
