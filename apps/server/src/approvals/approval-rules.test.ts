import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openApprovalRules, RULE_LIMITS } from "./approval-rules.js";

function setup(readOnly: (a: string) => boolean = (a) => a.endsWith(".read")) {
  let clock = 1_000_000;
  const rules = openApprovalRules(
    join(mkdtempSync(join(tmpdir(), "ar-")), "s.sqlite"),
    readOnly,
    () => clock,
  );
  return {
    rules,
    advance: (ms: number) => (clock += ms),
    setReadOnly: undefined,
  };
}
const base = { agentId: "a", actionType: "mcp.docs.read", target: "docs/1" };

describe("approval rules", () => {
  it("asks by default and when nothing matches exactly", () => {
    const { rules } = setup();
    expect(rules.evaluate("a", "mcp.docs.write", "docs/1")).toEqual({
      decision: "ask",
      ruleId: null,
    });
    const r = rules.create({ ...base, effect: "allow" });
    expect(rules.evaluate("a", base.actionType, "docs/2").decision).toBe("ask");
    expect(rules.evaluate("b", base.actionType, base.target).decision).toBe(
      "ask",
    );
    expect(rules.evaluate("a", "mcp.other.read", base.target).decision).toBe(
      "ask",
    );
    expect(rules.evaluate("a", base.actionType, base.target)).toEqual({
      decision: "allow",
      ruleId: r.id,
    });
  });

  it("lets an explicit deny win over allow and ask", () => {
    const { rules } = setup();
    rules.create({ ...base, effect: "allow" });
    rules.create({ ...base, effect: "ask" });
    const deny = rules.create({ ...base, effect: "deny" });
    expect(rules.evaluate("a", base.actionType, base.target)).toEqual({
      decision: "deny",
      ruleId: deny.id,
    });
    expect(rules.revoke("a", deny.id)).toBe(true);
    expect(rules.evaluate("a", base.actionType, base.target).decision).toBe(
      "allow",
    );
  });

  it("offers persistent allow only for verified read-only actions", () => {
    const { rules } = setup();
    expect(() =>
      rules.create({ ...base, actionType: "mcp.docs.write", effect: "allow" }),
    ).toThrow("read-only");
    expect(() =>
      rules.create({ ...base, actionType: "mcp.docs.write", effect: "deny" }),
    ).not.toThrow();
  });

  it("drops an allow when the action stops being verified read-only", () => {
    let readOnly = true;
    const { rules } = setup(() => readOnly);
    rules.create({ ...base, effect: "allow" });
    expect(rules.evaluate("a", base.actionType, base.target).decision).toBe(
      "allow",
    );
    readOnly = false;
    expect(rules.evaluate("a", base.actionType, base.target).decision).toBe(
      "ask",
    );
  });

  it("expires and revokes rules, scoped to the owning agent", () => {
    const { rules, advance } = setup();
    const timed = rules.create({ ...base, effect: "allow", ttlMs: 1000 });
    expect(rules.evaluate("a", base.actionType, base.target).decision).toBe(
      "allow",
    );
    advance(1000);
    expect(rules.evaluate("a", base.actionType, base.target).decision).toBe(
      "ask",
    );
    const live = rules.create({ ...base, effect: "allow" });
    expect(rules.revoke("b", live.id)).toBe(false);
    expect(rules.evaluate("a", base.actionType, base.target).decision).toBe(
      "allow",
    );
    expect(rules.revoke("a", live.id)).toBe(true);
    expect(rules.revoke("a", live.id)).toBe(false);
    expect(rules.evaluate("a", base.actionType, base.target).decision).toBe(
      "ask",
    );
    expect(rules.list("a").rules.map((r) => r.id)).toContain(timed.id);
  });

  it("validates input, bounds counts and pages the list", () => {
    const { rules } = setup();
    for (const bad of [
      { actionType: "Bad Type" },
      { target: "" },
      { target: "x".repeat(301) },
      { effect: "maybe" as never },
      { ttlMs: 0 },
    ])
      expect(() => rules.create({ ...base, effect: "deny", ...bad })).toThrow();
    for (let i = 0; i < RULE_LIMITS.perAgent; i++)
      rules.create({ ...base, target: `t${i}`, effect: "ask" });
    expect(() => rules.create({ ...base, effect: "ask" })).toThrow("Too many");
    expect(rules.list("a").rules).toHaveLength(RULE_LIMITS.pageSize);
    expect(rules.list("a", 4).hasMore).toBe(false);
    expect(rules.list("b").rules).toEqual([]);
  });
});
