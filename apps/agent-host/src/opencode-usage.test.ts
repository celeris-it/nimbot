import { expect, it } from "vitest";
import { measureUsage } from "./opencode-usage.js";
import type { UsageReading } from "./engine-usage.js";

const model = { providerId: "fixture", modelId: "counted" };
const reading = (
  counters: [string, number, number][],
  complete = true,
  priced = true,
): UsageReading => ({
  session: "owner",
  model,
  complete,
  priced,
  counters: counters.map(([id, input, cost]) => ({
    id,
    cost,
    tokens: { input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  })),
});

it("counts deltas for persistent and reused child sessions and totals for new children", () => {
  const first = reading([
    ["owner", 30, 0.25],
    ["old-child", 10, 0.25],
  ]);
  const second = reading([
    ["owner", 40, 0.5],
    ["old-child", 11, 0.5],
    ["new-child", 3, 0.125],
  ]);
  expect(measureUsage(first, second)).toMatchObject({
    state: "reported",
    tokens: { input: 14 },
    costUsd: 0.625,
  });
  const third = reading([
    ["owner", 42, 0.5],
    ["old-child", 11, 0.5],
    ["new-child", 3, 0.125],
  ]);
  expect(measureUsage(second, third)).toMatchObject({
    state: "reported",
    tokens: { input: 2 },
    costUsd: 0,
  });
});

it("preserves measured tokens on interruption and distinguishes unknown cost and resets", () => {
  const start = reading([["owner", 30, 0]], false, false);
  const end = reading([
    ["owner", 42, 0],
    ["unobserved-child", 3, 1],
  ]);
  expect(measureUsage(start, end, true)).toMatchObject({
    state: "partial",
    tokens: { input: 12 },
    costUsd: null,
  });
  expect(measureUsage(start, reading([["owner", 10, 0]]))).toMatchObject({
    state: "unavailable",
    tokens: null,
    costUsd: null,
  });
});
