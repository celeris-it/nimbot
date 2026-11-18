import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { GRANT_LIMITS, openAgentGrants } from "./agent-grants.js";

function setup() {
  const state = {
    telegram: { a: 1, b: 1, c: 2 } as Record<string, number | undefined>,
    discord: { a: "d1", b: "d1", c: "d1" } as Record<
      string,
      string | undefined
    >,
    deleted: new Set<string>(),
  };
  const grants = openAgentGrants(
    join(mkdtempSync(join(tmpdir(), "gr-")), "s.sqlite"),
    {
      exists: (id) => id in state.telegram && !state.deleted.has(id),
      telegramOwner: (id) => state.telegram[id],
      discordOwner: (id) => state.discord[id],
    },
  );
  return { grants, state };
}

it("has no grants by default and rejects self-targeting and foreign owners", () => {
  const { grants } = setup();
  expect(grants.allows("a", "b", "note", "telegram")).toBe(false);
  expect(grants.targets("a", "note", "telegram")).toEqual([]);
  expect(() => grants.grant("a", "a", "note")).toThrow();
  expect(() => grants.grant("a", "c", "note")).toThrow("same owner");
  expect(() => grants.grant("a", "ghost", "note")).toThrow();
  expect(() => grants.grant("a", "b", "admin" as never)).toThrow();
});

it("is directed and separate per permission", () => {
  const { grants } = setup();
  grants.grant("a", "b", "note");
  expect(grants.allows("a", "b", "note", "telegram")).toBe(true);
  expect(grants.allows("b", "a", "note", "telegram")).toBe(false);
  expect(grants.allows("a", "b", "delegate", "telegram")).toBe(false);
  expect(grants.grant("a", "b", "note").permission).toBe("note");
  expect(grants.list("a")).toHaveLength(1);
  expect(grants.revoke("a", "b", "note")).toBe(true);
  expect(grants.revoke("a", "b", "note")).toBe(false);
  expect(grants.allows("a", "b", "note", "telegram")).toBe(false);
});

it("rechecks ownership on every request and prunes grants that stop qualifying", () => {
  const { grants, state } = setup();
  grants.grant("a", "b", "delegate");
  expect(grants.targets("a", "delegate", "telegram")).toEqual(["b"]);
  state.telegram.b = 2;
  expect(grants.allows("a", "b", "delegate", "telegram")).toBe(false);
  expect(grants.targets("a", "delegate", "telegram")).toEqual([]);
  expect(grants.list("a")).toHaveLength(1);
  expect(grants.prune()).toBe(1);
  expect(grants.list("a")).toEqual([]);
  state.telegram.b = 1;
  expect(grants.allows("a", "b", "delegate", "telegram")).toBe(false);
});

it("also needs matching Discord owners for requests that began in Discord", () => {
  const { grants, state } = setup();
  grants.grant("a", "b", "note");
  expect(grants.allows("a", "b", "note", "discord")).toBe(true);
  state.discord.b = "d2";
  expect(grants.allows("a", "b", "note", "discord")).toBe(false);
  expect(grants.allows("a", "b", "note", "telegram")).toBe(true);
  state.discord.b = undefined;
  expect(grants.allows("a", "b", "note", "discord")).toBe(false);
});

it("stops when a target is deleted and bounds the grants per source", () => {
  const { grants, state } = setup();
  grants.grant("a", "b", "note");
  state.deleted.add("b");
  expect(grants.allows("a", "b", "note", "telegram")).toBe(false);
  expect(GRANT_LIMITS.perAgent).toBeGreaterThan(0);
});
