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

export const modelAdmission = z.strictObject({
  model: modelReference,
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
    | "model_unavailable";
  checkedAt: number;
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
  list(): Promise<(ModelReference & { name: string })[]>;
  check(selected: ModelReference | null, issue: boolean): Promise<ModelCheck>;
  accept(admission: ModelAdmission): boolean;
}
