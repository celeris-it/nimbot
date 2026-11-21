import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  EngineModels,
  ModelAdmission,
  ModelCheck,
  ModelReference,
} from "./engine-usage.js";
import { readOpenCodeCredentials } from "./opencode-auth.js";
import { OpenCodeStartupError, type OpenCodeRequest } from "./opencode-api.js";

const apiModelRef = z.object({
  providerID: z.string().min(1).max(256),
  id: z.string().min(1).max(256),
});
const catalog = z.object({
  data: z.array(
    apiModelRef.extend({
      enabled: z.boolean(),
      name: z.string().min(1),
      cost: z.array(z.object({ input: z.number().nonnegative() })).optional(),
      settings: z.object({ baseURL: z.string().optional() }).optional(),
    }),
  ),
});
const defaultModel = z.object({ data: apiModelRef.nullable() });
const meter = z.object({
  percent: z.number().min(0).max(100),
  limited: z.boolean(),
  resetsAt: z.int().nonnegative(),
});
const limits = z.object({
  data: z
    .object({
      go: z
        .object({ rolling: meter, weekly: meter, monthly: meter })
        .optional(),
      budgets: z.array(
        z.object({
          id: z.string(),
          limit: z.number().nonnegative(),
          spent: z.number().nonnegative(),
          per: z.enum(["set", "model"]),
          coverage: z.enum(["all", "models"]),
          models: z.array(
            z.object({
              providerID: z.string(),
              modelID: z.string(),
              spent: z.number().nonnegative().optional(),
            }),
          ),
          resetsAt: z.int().nonnegative(),
        }),
      ),
    })
    .nullable(),
});

function reference(model: z.infer<typeof apiModelRef>): ModelReference {
  return { providerId: model.providerID, modelId: model.id };
}

const providerList = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      canonical: z.string().optional(),
      integrationID: z.string().optional(),
      settings: z.object({ baseURL: z.string().optional() }).optional(),
    }),
  ),
});

function quotaSource(
  providerId: string,
  endpoint: string | undefined,
  provider?: z.infer<typeof providerList>["data"][number],
) {
  const base = endpoint ?? provider?.settings?.baseURL;
  const url = base && URL.canParse(base) ? new URL(base) : undefined;
  const hostedPath = url?.origin === "https://opencode.ai" ? url.pathname : "";
  if (
    providerId === "opencode-go" ||
    provider?.integrationID === "opencode-go" ||
    /^\/(?:inference\/go|zen\/go\/v1)(?:\/|$)/.test(hostedPath) ||
    (provider?.integrationID === "opencode" &&
      provider.canonical === "opencode-go")
  )
    return "go";
  if (
    providerId === "opencode" ||
    provider?.integrationID === "opencode" ||
    /^\/(?:inference|zen\/v1)(?:\/|$)/.test(hostedPath)
  )
    return "console";
  return undefined;
}

function sameModel(left: ModelReference | null, right: ModelReference | null) {
  return (
    left?.providerId === right?.providerId && left?.modelId === right?.modelId
  );
}

function listModels(value: unknown) {
  return catalog.parse(value).data.filter((model) => model.enabled);
}

export function quotaWindows(
  raw: unknown,
  model: ModelReference,
  go = model.providerId === "opencode-go",
) {
  const { data } = limits.parse(raw);
  if (!data) return [];
  if (go) {
    return data.go
      ? Object.entries(data.go).map(([name, window]) => ({
          name: `Go ${name}`,
          usedPercent: window.percent,
          exhausted: window.limited,
          resetsAt: window.resetsAt,
        }))
      : [];
  }
  return data.budgets.flatMap((budget) => {
    const matched = budget.models.find(
      (item) =>
        item.providerID === model.providerId && item.modelID === model.modelId,
    );
    if (!matched && budget.coverage !== "all") return [];
    const spent = budget.per === "model" ? (matched?.spent ?? 0) : budget.spent;
    return [
      {
        name:
          budget.per === "model"
            ? "Console monthly (per model)"
            : "Console monthly",
        usedPercent:
          budget.limit === 0
            ? 100
            : Math.min(100, (spent / budget.limit) * 100),
        exhausted: spent >= budget.limit,
        resetsAt: budget.resetsAt,
        limitUsd: budget.limit,
        spentUsd: spent,
      },
    ];
  });
}

export function createOpenCodeModels(
  request: OpenCodeRequest,
  isBusy: () => boolean,
): EngineModels & {
  changed(): void;
  hasCost(model: ModelReference): Promise<boolean>;
} {
  // Only the Server requests admissions. UI reads never create or invalidate one.
  let generation = 0;
  let issued: { admission: ModelAdmission; expiresAt: number } | undefined;
  const changed = () => {
    generation++;
    issued = undefined;
  };
  return {
    changed,
    async list() {
      const models = listModels(await request("/api/model"));
      return models.map((model) => ({
        ...reference(model),
        name: model.name.slice(0, 256),
      }));
    },
    async check(
      selected: ModelReference | null,
      issue: boolean,
    ): Promise<ModelCheck> {
      const revision = generation;
      const checkedAt = Date.now();
      const result: ModelCheck = {
        model: selected,
        state: "checking",
        checkedAt,
        windows: [],
      };
      if (issue && isBusy()) return result;
      try {
        const [raw, catalogValue, credentials] = await Promise.all([
          selected
            ? undefined
            : request("/api/model/default").then(
                (value) => defaultModel.parse(value).data,
              ),
          request("/api/model"),
          readOpenCodeCredentials(request),
        ]);
        result.model = selected ?? (raw ? reference(raw) : null);
        const models = listModels(catalogValue);
        const model = result.model;
        const selectedEntry = models.find((entry) =>
          sameModel(model, reference(entry)),
        );
        if (!model || !selectedEntry)
          return { ...result, state: "model_unavailable" };

        if (
          credentials.some(
            (entry) =>
              entry.active &&
              entry.integrationID === "opencode" &&
              entry.value.type === "oauth",
          )
        ) {
          const endpoint = selectedEntry.settings?.baseURL;
          // Console can publish workspace providers under arbitrary IDs. Use its
          // provider ownership metadata when the model does not identify its route.
          const source =
            quotaSource(model.providerId, endpoint) ??
            quotaSource(
              model.providerId,
              endpoint,
              providerList
                .parse(await request("/api/provider"))
                .data.find((entry) => entry.id === model.providerId),
            );
          if (source) {
            const rawLimits = await request("/api/experimental/usage/limits", {
              timeout: 17_000,
            });
            if (limits.parse(rawLimits).data === null)
              return { ...result, failure: "quota_check_failed" };
            result.windows = quotaWindows(rawLimits, model, source === "go");
          }
        }
        if (revision !== generation || (issue && isBusy())) return result;
        result.state = result.windows.some((window) => window.exhausted)
          ? "exhausted"
          : result.windows.length
            ? "available"
            : "unavailable";
        if (issue && result.state !== "exhausted") {
          result.admission = { model, revision: randomUUID() };
          issued = {
            admission: result.admission,
            expiresAt: Date.now() + 120_000,
          };
        }
        return result;
      } catch (error) {
        return {
          ...result,
          failure:
            error instanceof OpenCodeStartupError
              ? error.reason
              : "opencode_check_failed",
        };
      }
    },
    accept(admission: ModelAdmission) {
      if (
        issued?.admission.revision !== admission.revision ||
        Date.now() >= issued.expiresAt ||
        !sameModel(issued.admission.model, admission.model)
      )
        return false;
      issued = undefined;
      return true;
    },
    async hasCost(model: ModelReference) {
      const [raw, credentials] = await Promise.all([
        request("/api/model"),
        readOpenCodeCredentials(request),
      ]);
      if (
        model.providerId === "openai" &&
        credentials.some(
          (entry) =>
            entry.active &&
            entry.integrationID === "openai" &&
            entry.value.type === "oauth",
        )
      )
        return false;
      return !!listModels(raw).find((entry) =>
        sameModel(reference(entry), model),
      )?.cost?.length;
    },
  };
}
