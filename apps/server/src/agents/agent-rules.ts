import type { DatabaseSync } from "node:sqlite";

export const RULE_MARKDOWN_LIMIT = 4000;
export const RULE_SCOPE_LIMIT = 16_000;

export interface AgentRule {
  id: number;
  markdown: string;
}

export function formatRules(rules: readonly AgentRule[]) {
  return rules.map(({ markdown }) => markdown).join("\n\n---\n\n");
}

export class RuleLimitError extends Error {}

export function agentRules(db: DatabaseSync) {
  const list = (scope: string | null): AgentRule[] =>
    db
      .prepare(
        "SELECT id, markdown FROM agent_rules WHERE agent_id IS ? ORDER BY id",
      )
      .all(scope) as unknown as AgentRule[];
  return {
    list,
    save(
      scope: string | null,
      input: Omit<AgentRule, "id">,
      id?: number,
    ): AgentRule | undefined {
      db.exec("BEGIN IMMEDIATE");
      try {
        const { markdown } = input;
        const saved =
          id === undefined
            ? db
                .prepare(
                  "INSERT INTO agent_rules (agent_id, markdown) VALUES (?, ?) RETURNING id, markdown",
                )
                .get(scope, markdown)
            : db
                .prepare(
                  "UPDATE agent_rules SET markdown = ? WHERE agent_id IS ? AND id = ? RETURNING id, markdown",
                )
                .get(markdown, scope, id);
        if (saved && formatRules(list(scope)).length > RULE_SCOPE_LIMIT)
          throw new RuleLimitError("Rule text exceeds the scope limit");
        db.exec("COMMIT");
        return saved as AgentRule | undefined;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    remove(scope: string | null, id: number) {
      return (
        db
          .prepare("DELETE FROM agent_rules WHERE agent_id IS ? AND id = ?")
          .run(scope, id).changes > 0
      );
    },
  };
}
