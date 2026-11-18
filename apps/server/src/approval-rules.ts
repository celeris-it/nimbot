import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type RuleEffect = "ask" | "deny" | "allow";
export interface ApprovalRule {
  id: string;
  agentId: string;
  actionType: string;
  target: string;
  effect: RuleEffect;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}
export type RuleDecision = {
  decision: RuleEffect;
  /** The rule that decided, or null for the default of asking. */
  ruleId: string | null;
};

export const RULE_LIMITS = {
  perAgent: 200,
  pageSize: 50,
  maxTtlMs: 365 * 86_400_000,
} as const;

const IDENT = /^[a-z][a-z0-9_.:-]{0,63}$/;
const PRECEDENCE: Record<RuleEffect, number> = { deny: 3, allow: 2, ask: 1 };

/**
 * Per-agent rules over a trusted operation identifier and an exact target.
 * Matching never looks at model text or ACP titles. An explicit deny wins over
 * allow, which wins over ask; with no rule the answer is to ask. A persistent
 * allow exists only for operations the service itself can verify as read-only.
 */
export function openApprovalRules(
  path: string,
  /** Service-owned list of operations known to be read-only. */
  isVerifiedReadOnly: (actionType: string) => boolean,
  now: () => number = Date.now,
) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS approval_rules (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      target TEXT NOT NULL,
      effect TEXT NOT NULL CHECK(effect IN ('ask', 'deny', 'allow')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER
    )`);
    db.exec(
      "CREATE INDEX IF NOT EXISTS approval_rules_lookup ON approval_rules (agent_id, action_type, target)",
    );
  } catch (error) {
    db.close();
    throw error;
  }
  const map = (r: Record<string, unknown>): ApprovalRule => ({
    id: String(r.id),
    agentId: String(r.agent_id),
    actionType: String(r.action_type),
    target: String(r.target),
    effect: r.effect as RuleEffect,
    createdAt: Number(r.created_at),
    expiresAt: r.expires_at === null ? null : Number(r.expires_at),
    revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
  });
  return {
    create(input: {
      agentId: string;
      actionType: string;
      target: string;
      effect: RuleEffect;
      ttlMs?: number;
    }): ApprovalRule {
      if (
        !input.agentId ||
        !IDENT.test(input.actionType) ||
        !input.target ||
        input.target.length > 300 ||
        !["ask", "deny", "allow"].includes(input.effect) ||
        (input.ttlMs !== undefined &&
          (!Number.isSafeInteger(input.ttlMs) ||
            input.ttlMs < 1 ||
            input.ttlMs > RULE_LIMITS.maxTtlMs))
      )
        throw new Error("Invalid rule");
      if (input.effect === "allow" && !isVerifiedReadOnly(input.actionType))
        throw new Error("Always allow is only available for read-only actions");
      const count = Number(
        db
          .prepare(
            "SELECT count(*) AS n FROM approval_rules WHERE agent_id = ? AND revoked_at IS NULL",
          )
          .get(input.agentId)!.n,
      );
      if (count >= RULE_LIMITS.perAgent) throw new Error("Too many rules");
      const at = now();
      const id = randomUUID();
      db.prepare(
        "INSERT INTO approval_rules (id, agent_id, action_type, target, effect, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      ).run(
        id,
        input.agentId,
        input.actionType,
        input.target,
        input.effect,
        at,
        input.ttlMs === undefined ? null : at + input.ttlMs,
      );
      return map(
        db.prepare("SELECT * FROM approval_rules WHERE id = ?").get(id)!,
      );
    },
    /** Scoped to the agent so one agent's panel action cannot revoke another's rule. */
    revoke(agentId: string, id: string): boolean {
      return (
        db
          .prepare(
            "UPDATE approval_rules SET revoked_at = ? WHERE id = ? AND agent_id = ? AND revoked_at IS NULL",
          )
          .run(now(), id, agentId).changes === 1
      );
    },
    /** Evaluated again immediately before each side effect. */
    evaluate(
      agentId: string,
      actionType: string,
      target: string,
    ): RuleDecision {
      const rows = db
        .prepare(
          "SELECT * FROM approval_rules WHERE agent_id = ? AND action_type = ? AND target = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
        )
        .all(agentId, actionType, target, now())
        .map(map);
      let best: ApprovalRule | undefined;
      for (const rule of rows) {
        // A persistent allow is re-verified now, so a changed classification drops it.
        if (rule.effect === "allow" && !isVerifiedReadOnly(actionType))
          continue;
        if (!best || PRECEDENCE[rule.effect] > PRECEDENCE[best.effect])
          best = rule;
      }
      return best
        ? { decision: best.effect, ruleId: best.id }
        : { decision: "ask", ruleId: null };
    },
    /** Newest first, one bounded page for the panel. */
    list(
      agentId: string,
      page = 1,
    ): { rules: ApprovalRule[]; hasMore: boolean } {
      const size = RULE_LIMITS.pageSize;
      const rows = db
        .prepare(
          "SELECT * FROM approval_rules WHERE agent_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?",
        )
        .all(agentId, size + 1, (Math.max(1, Math.floor(page)) - 1) * size);
      return {
        rules: rows.slice(0, size).map(map),
        hasMore: rows.length > size,
      };
    },
    close() {
      db.close();
    },
  };
}
export type ApprovalRules = ReturnType<typeof openApprovalRules>;
