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
export const modelCatalog = z.object({
  models: z
    .array(modelReference.extend({ name: z.string().min(1).max(256) }))
    .max(20_000),
});
export const modelAdmission = z.strictObject({
  model: modelReference,
  revision: z.uuid(),
});
export type ModelAdmission = z.infer<typeof modelAdmission>;

const token = z.int().nonnegative();
export const taskUsage = z.object({
  model: modelReference,
  tokens: z
    .object({
      input: token,
      output: token,
      reasoning: token,
      cacheRead: token,
      cacheWrite: token,
    })
    .nullable(),
  costUsd: z.number().nonnegative().nullable(),
  state: z.enum(["reported", "partial", "unavailable"]),
});
export type TaskUsage = z.infer<typeof taskUsage>;

export const quotaStatus = z.object({
  model: modelReference.nullable(),
  state: z.enum([
    "available",
    "unavailable",
    "exhausted",
    "checking",
    "model_unavailable",
  ]),
  checkedAt: z.int().nonnegative(),
  failure: z
    .enum([
      "host_unavailable",
      "opencode_missing",
      "opencode_start_failed",
      "opencode_start_timeout",
      "opencode_check_failed",
      "quota_check_failed",
    ])
    .optional(),
  windows: z
    .array(
      z.object({
        name: z.enum([
          "Go rolling",
          "Go weekly",
          "Go monthly",
          "Console monthly",
          "Console monthly (per model)",
        ]),
        usedPercent: z.number().min(0).max(100),
        exhausted: z.boolean(),
        resetsAt: z.int().nonnegative(),
        limitUsd: z.number().nonnegative().optional(),
        spentUsd: z.number().nonnegative().optional(),
      }),
    )
    .max(200),
});
export type QuotaStatus = z.infer<typeof quotaStatus>;
export const modelCheck = quotaStatus.extend({
  admission: modelAdmission.optional(),
});
export interface AgentModels {
  selected: ModelReference | null;
  models: z.infer<typeof modelCatalog>["models"];
  catalogAvailable: boolean;
}

interface UsageTotals {
  tokens: number;
  costUsd: number | null;
  tasks: number;
  missingCost: number;
  incomplete: number;
}
export interface AgentUsage {
  quota: QuotaStatus | null;
  queued: number;
  today: UsageTotals;
  month: UsageTotals;
  tasks: {
    id: string;
    startedAt: number;
    status: string;
    origin: string;
    scheduleName: string | null;
    usage: TaskUsage | null;
  }[];
  next: number | null;
}

export interface UsageOverview {
  days: { day: string; costUsd: number; tokens: number; tasks: number }[];
  models: (ModelReference & {
    costUsd: number;
    tokens: number;
    tasks: number;
  })[];
  missingCost: number;
  /** Tightest quota window per AI provider, from the latest agent checks. */
  quotas: {
    providerId: string;
    window: string;
    remainingPercent: number;
    resetsAt: number;
    exhausted: boolean;
  }[];
  /** 48 hourly buckets, oldest first: the previous 24 hours, then the last 24. */
  hourly: { hour: string; costUsd: number; tokens: number }[];
}
