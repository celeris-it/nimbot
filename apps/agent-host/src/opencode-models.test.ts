import { expect, it, vi } from "vitest";
import { createOpenCodeModels, quotaWindows } from "./opencode-models.js";
import { OpenCodeStartupError, type OpenCodeRequest } from "./opencode-api.js";

const consoleModel = { providerId: "opencode", modelId: "vendor/model" };
const goModel = { providerId: "opencode-go", modelId: "model" };

it.each([
  "opencode_missing",
  "opencode_start_failed",
  "opencode_start_timeout",
] as const)("reports %s without issuing a model admission", async (reason) => {
  const request: OpenCodeRequest = async () => {
    throw new OpenCodeStartupError(reason);
  };
  await expect(
    createOpenCodeModels(request, () => false).check(null, true),
  ).resolves.toEqual({
    model: null,
    state: "checking",
    failure: reason,
    checkedAt: expect.any(Number),
    windows: [],
  });
});
const resetsAt = 2_000_000_000_000;
const budget = {
  id: "rule",
  limit: 20,
  spent: 20,
  per: "set",
  coverage: "models",
  models: [
    {
      providerID: consoleModel.providerId,
      modelID: consoleModel.modelId,
      spent: 10,
    },
  ],
  resetsAt,
};

it("matches Console budgets to the specific model and uses per-model spend when applicable", () => {
  expect(quotaWindows({ data: { budgets: [budget] } }, consoleModel)).toEqual([
    {
      name: "Console monthly",
      usedPercent: 100,
      exhausted: true,
      resetsAt,
      limitUsd: 20,
      spentUsd: 20,
    },
  ]);
  expect(
    quotaWindows(
      { data: { budgets: [{ ...budget, per: "model" }] } },
      consoleModel,
    )[0],
  ).toMatchObject({ usedPercent: 50, exhausted: false, spentUsd: 10 });
  expect(
    quotaWindows(
      { data: { budgets: [budget] } },
      { ...consoleModel, modelId: "other" },
    ),
  ).toEqual([]);
});

it("applies the authoritative limit flag to each Go window", () => {
  const rolling = { percent: 100, limited: false, resetsAt };
  const weekly = { percent: 100, limited: true, resetsAt };
  const monthly = { percent: 20, limited: false, resetsAt };
  expect(
    quotaWindows(
      { data: { budgets: [budget], go: { rolling, weekly, monthly } } },
      goModel,
    ),
  ).toMatchObject([
    { exhausted: false },
    { exhausted: true },
    { exhausted: false },
  ]);
});

it("waits for a valid response on a covered provider and invalidates permits on credential changes", async () => {
  let mode: "error" | "empty" | "limited" | "ready" = "error";
  const model = {
    id: consoleModel.modelId,
    providerID: consoleModel.providerId,
    enabled: true,
    name: "Model",
  };
  const request = vi.fn<OpenCodeRequest>(async (path) => {
    if (path === "/api/model") return { data: [model] };
    if (path === "/api/model/default") return { data: model };
    if (path === "/api/credential")
      return {
        data: [
          {
            id: "connected",
            integrationID: "opencode",
            active: true,
            value: { type: "oauth" },
          },
        ],
      };
    if (mode === "error") throw new Error("API not available");
    if (mode === "empty") return { data: null };
    return {
      data: { budgets: [{ ...budget, spent: mode === "limited" ? 20 : 10 }] },
    };
  });
  const models = createOpenCodeModels(request, () => false);
  expect(await models.check(null, true)).toMatchObject({
    state: "checking",
    model: consoleModel,
    failure: "opencode_check_failed",
  });
  mode = "empty";
  expect(await models.check(null, true)).toMatchObject({
    state: "checking",
    failure: "quota_check_failed",
  });
  mode = "limited";
  expect((await models.check(consoleModel, true)).state).toBe("exhausted");
  mode = "ready";
  const status = await models.check(consoleModel, true);
  expect(status.state).toBe("available");
  expect(status.admission).toBeDefined();
  models.changed();
  expect(models.accept(status.admission!)).toBe(false);
  const refreshed = await models.check(consoleModel, true);
  expect(models.accept(refreshed.admission!)).toBe(true);
  expect(models.accept(refreshed.admission!)).toBe(false);
  expect(
    (await models.check({ ...consoleModel, modelId: "retired" }, true)).state,
  ).toBe("model_unavailable");
});

it("admits directly connected models when OpenCode has no account limit for the provider", async () => {
  const model = {
    id: "model",
    providerID: "openai",
    enabled: true,
    name: "OpenAI model",
  };
  const request = vi.fn<OpenCodeRequest>(async (path) => ({
    data: path === "/api/credential" ? [] : [model],
  }));
  const models = createOpenCodeModels(request, () => false);
  expect(
    await models.check({ providerId: "openai", modelId: "model" }, true),
  ).toMatchObject({
    state: "unavailable",
    admission: { model: { providerId: "openai", modelId: "model" } },
  });
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    "/api/model",
    "/api/credential",
  ]);
});

it.each([
  [{ integrationID: "opencode" }, "Console monthly"],
  [
    {
      settings: { baseURL: "https://opencode.ai/inference/custom/connection" },
    },
    "Console monthly",
  ],
  [
    { settings: { baseURL: "https://opencode.ai/inference/go/v1" } },
    "Go rolling",
  ],
  [
    {
      settings: {
        baseURL: "https://opencode.ai.example/inference/custom/connection",
      },
    },
    null,
  ],
] as const)(
  "resolves workspace aliases from OpenCode provider metadata (%j)",
  async (metadata, window) => {
    const alias = { providerId: "workspace-models", modelId: "vendor/model" };
    const request = vi.fn<OpenCodeRequest>(async (path) => {
      switch (path) {
        case "/api/model":
          return {
            data: [
              {
                id: alias.modelId,
                providerID: alias.providerId,
                name: "Workspace model",
                enabled: true,
              },
            ],
          };
        case "/api/credential":
          return {
            data: [
              {
                id: "workspace",
                integrationID: "opencode",
                active: true,
                value: { type: "oauth" },
              },
            ],
          };
        case "/api/provider":
          return { data: [{ id: alias.providerId, ...metadata }] };
        case "/api/experimental/usage/limits":
          return {
            data: {
              go: {
                rolling: { percent: 100, limited: true, resetsAt },
                weekly: { percent: 20, limited: false, resetsAt },
                monthly: { percent: 10, limited: false, resetsAt },
              },
              budgets: [
                {
                  ...budget,
                  models: [
                    { providerID: alias.providerId, modelID: alias.modelId },
                  ],
                },
              ],
            },
          };
        default:
          throw new Error("Unexpected API request");
      }
    });
    const result = await createOpenCodeModels(request, () => false).check(
      alias,
      true,
    );
    expect(result.state).toBe(window ? "exhausted" : "unavailable");
    expect(result.windows[0]?.name ?? null).toBe(window);
    expect(!!result.admission).toBe(!window);
    expect(
      request.mock.calls.some(
        ([path]) => path === "/api/experimental/usage/limits",
      ),
    ).toBe(!!window);
  },
);
