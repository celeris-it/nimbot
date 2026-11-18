import { DatabaseSync } from "node:sqlite";

export type PeerPermission = "note" | "delegate";
export interface PeerGrant {
  sourceAgentId: string;
  targetAgentId: string;
  permission: PeerPermission;
  createdAt: number;
}
/** The verified origin of the request, as the Server recorded it. */
export type PeerOrigin = "telegram" | "discord";

export const GRANT_LIMITS = { perAgent: 50, pageSize: 50 } as const;

/**
 * Directed grants between agents. The default is no grant and no self-target.
 * A grant works only while both agents share the same configured Telegram owner;
 * a request that began in Discord also needs matching Discord owners. Ownership
 * is read from the registry on every check, so a changed owner or binding stops
 * the grant at once, and `prune` removes the ones that no longer qualify.
 */
export function openAgentGrants(
  path: string,
  owners: {
    exists(agentId: string): boolean;
    telegramOwner(agentId: string): number | undefined;
    discordOwner(agentId: string): string | undefined;
  },
  now: () => number = Date.now,
) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS agent_grants (
      source_agent_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      permission TEXT NOT NULL CHECK(permission IN ('note', 'delegate')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (source_agent_id, target_agent_id, permission),
      CHECK (source_agent_id != target_agent_id)
    )`);
  } catch (error) {
    db.close();
    throw error;
  }
  function sameOwners(
    source: string,
    target: string,
    origin: PeerOrigin = "telegram",
  ): boolean {
    if (source === target || !owners.exists(source) || !owners.exists(target))
      return false;
    const a = owners.telegramOwner(source);
    if (a === undefined || a !== owners.telegramOwner(target)) return false;
    if (origin === "discord") {
      const d = owners.discordOwner(source);
      return d !== undefined && d === owners.discordOwner(target);
    }
    return true;
  }
  const map = (r: Record<string, unknown>): PeerGrant => ({
    sourceAgentId: String(r.source_agent_id),
    targetAgentId: String(r.target_agent_id),
    permission: r.permission as PeerPermission,
    createdAt: Number(r.created_at),
  });
  return {
    grant(
      sourceAgentId: string,
      targetAgentId: string,
      permission: PeerPermission,
    ): PeerGrant {
      if (
        !["note", "delegate"].includes(permission) ||
        !sameOwners(sourceAgentId, targetAgentId)
      )
        throw new Error("Agents must be different and share the same owner");
      const count = Number(
        db
          .prepare(
            "SELECT count(*) AS n FROM agent_grants WHERE source_agent_id = ?",
          )
          .get(sourceAgentId)!.n,
      );
      if (count >= GRANT_LIMITS.perAgent) throw new Error("Too many grants");
      db.prepare(
        "INSERT INTO agent_grants (source_agent_id, target_agent_id, permission, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
      ).run(sourceAgentId, targetAgentId, permission, now());
      return map(
        db
          .prepare(
            "SELECT * FROM agent_grants WHERE source_agent_id = ? AND target_agent_id = ? AND permission = ?",
          )
          .get(sourceAgentId, targetAgentId, permission)!,
      );
    },
    revoke(
      sourceAgentId: string,
      targetAgentId: string,
      permission: PeerPermission,
    ): boolean {
      return (
        db
          .prepare(
            "DELETE FROM agent_grants WHERE source_agent_id = ? AND target_agent_id = ? AND permission = ?",
          )
          .run(sourceAgentId, targetAgentId, permission).changes === 1
      );
    },
    /** Rechecked on each request: the grant exists and ownership still matches. */
    allows(
      sourceAgentId: string,
      targetAgentId: string,
      permission: PeerPermission,
      origin: PeerOrigin,
    ): boolean {
      return (
        !!db
          .prepare(
            "SELECT 1 FROM agent_grants WHERE source_agent_id = ? AND target_agent_id = ? AND permission = ?",
          )
          .get(sourceAgentId, targetAgentId, permission) &&
        sameOwners(sourceAgentId, targetAgentId, origin)
      );
    },
    /** Targets this source may currently reach with a permission. */
    targets(
      sourceAgentId: string,
      permission: PeerPermission,
      origin: PeerOrigin,
    ): string[] {
      return db
        .prepare(
          "SELECT target_agent_id FROM agent_grants WHERE source_agent_id = ? AND permission = ? ORDER BY target_agent_id LIMIT ?",
        )
        .all(sourceAgentId, permission, GRANT_LIMITS.perAgent)
        .map((r) => String(r.target_agent_id))
        .filter((target) => sameOwners(sourceAgentId, target, origin));
    },
    /** Deletes grants that no longer qualify, e.g. after an owner or binding change. */
    prune(): number {
      let removed = 0;
      for (const grant of db
        .prepare("SELECT * FROM agent_grants")
        .all()
        .map(map))
        if (!sameOwners(grant.sourceAgentId, grant.targetAgentId))
          removed += this.revoke(
            grant.sourceAgentId,
            grant.targetAgentId,
            grant.permission,
          )
            ? 1
            : 0;
      return removed;
    },
    list(sourceAgentId: string): PeerGrant[] {
      return db
        .prepare(
          "SELECT * FROM agent_grants WHERE source_agent_id = ? ORDER BY target_agent_id, permission LIMIT ?",
        )
        .all(sourceAgentId, GRANT_LIMITS.perAgent)
        .map(map);
    },
    close() {
      db.close();
    },
  };
}
export type AgentGrants = ReturnType<typeof openAgentGrants>;
