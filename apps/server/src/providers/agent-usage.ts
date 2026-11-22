import { DatabaseSync } from "node:sqlite";
import type { AgentHostConfig } from "../host/agent-host.js";
import { log } from "../logger.js";
import {
  modelCatalog,
  modelCheck,
  quotaStatus,
  taskUsage,
  type AgentUsage,
  type ModelReference,
  type QuotaStatus,
  type TaskUsage,
} from "./usage-contracts.js";

function readJson<T>(value: unknown): T | null {
  return typeof value === "string" ? (JSON.parse(value) as T) : null;
}

export function openAgentUsage(path: string, now = Date.now) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS agent_models (
        agent_id TEXT PRIMARY KEY,
        model TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        quota TEXT,
        checked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS task_usage (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        usage TEXT NOT NULL,
        total_tokens INTEGER,
        cost_usd REAL,
        complete INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_usage ON tasks(agent_id, started_at) WHERE host_task_id IS NOT NULL;
    `);
  } catch (error) {
    db.close();
    throw error;
  }

  function settings(id: string) {
    const row = db
      .prepare("SELECT * FROM agent_models WHERE agent_id = ?")
      .get(id);
    return {
      selected: readJson<ModelReference>(row?.model),
      revision: Number(row?.revision ?? 0),
      quota: readJson<QuotaStatus>(row?.quota),
    };
  }

  function totals(id: string, from: number): AgentUsage["today"] {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS tasks, COALESCE(SUM(u.total_tokens), 0) AS tokens,
        SUM(u.cost_usd) AS cost,
        COALESCE(SUM(u.cost_usd IS NULL), 0) AS missingCost,
        COALESCE(SUM(COALESCE(u.complete, 0) = 0), 0) AS incomplete
      FROM tasks t LEFT JOIN task_usage u ON u.task_id = t.id
      WHERE t.agent_id = ? AND t.host_task_id IS NOT NULL AND t.started_at >= ?`,
      )
      .get(id, from)!;
    return {
      tasks: Number(row.tasks),
      tokens: Number(row.tokens),
      costUsd: row.cost === null ? null : Number(row.cost),
      missingCost: Number(row.missingCost),
      incomplete: Number(row.incomplete),
    };
  }

  return {
    settings,
    setModel(id: string, model: ModelReference | null) {
      db.prepare(
        `INSERT INTO agent_models (agent_id, model, revision) VALUES (?, ?, 1)
        ON CONFLICT(agent_id) DO UPDATE SET model = excluded.model, revision = revision + 1, quota = NULL, checked_at = NULL`,
      ).run(id, model ? JSON.stringify(model) : null);
    },
    invalidate(id: string) {
      db.prepare(
        `INSERT INTO agent_models (agent_id, revision) VALUES (?, 1)
        ON CONFLICT(agent_id) DO UPDATE SET revision = revision + 1, quota = NULL, checked_at = NULL`,
      ).run(id);
    },
    saveQuota(id: string, revision: number, quota: QuotaStatus) {
      db.prepare(
        "INSERT INTO agent_models (agent_id) VALUES (?) ON CONFLICT DO NOTHING",
      ).run(id);
      return (
        db
          .prepare(
            `UPDATE agent_models SET quota = ?, checked_at = ?
        WHERE agent_id = ? AND revision = ? AND COALESCE(checked_at, 0) <= ?`,
          )
          .run(
            JSON.stringify(quota),
            quota.checkedAt,
            id,
            revision,
            quota.checkedAt,
          ).changes === 1
      );
    },
    record(agentId: string, id: string, hostTaskId: string, usage: TaskUsage) {
      const total =
        usage.tokens &&
        Object.values(usage.tokens).reduce((sum, value) => sum + value, 0);
      if (total !== null && !Number.isSafeInteger(total)) return;
      db.prepare(
        `INSERT INTO task_usage (task_id, usage, total_tokens, cost_usd, complete)
        SELECT id, ?, ?, ?, ? FROM tasks WHERE id = ? AND agent_id = ? AND host_task_id = ?
        ON CONFLICT DO NOTHING`,
      ).run(
        JSON.stringify(usage),
        total,
        usage.costUsd,
        Number(usage.state === "reported"),
        id,
        agentId,
        hostTaskId,
      );
    },
    pendingRecovery() {
      // Read-only recovery of recent terminal tasks whose Host event was missed.
      return db
        .prepare(
          `SELECT agent_id AS agentId, id, host_task_id AS hostTaskId
        FROM tasks t WHERE host_task_id IS NOT NULL AND status IN ('interrupted', 'failed', 'cancelled')
          AND updated_at >= ? AND NOT EXISTS (SELECT 1 FROM task_usage u WHERE u.task_id = t.id)
        ORDER BY updated_at DESC LIMIT 100`,
        )
        .all(now() - 86_400_000) as {
        agentId: string;
        id: string;
        hostTaskId: string;
      }[];
    },
    queuedAgents() {
      return db
        .prepare(
          "SELECT DISTINCT agent_id AS id FROM tasks WHERE status = 'queued'",
        )
        .all()
        .map((row) => String(row.id));
    },
    report(id: string, before = Number.MAX_SAFE_INTEGER): AgentUsage {
      const date = new Date(now());
      const rows = db
        .prepare(
          `SELECT seq, t.id, started_at, t.status, schedule_name,
        COALESCE(schedule_trigger, t.platform) AS origin, u.usage
        FROM tasks t LEFT JOIN task_usage u ON u.task_id = t.id
        WHERE t.agent_id = ? AND t.host_task_id IS NOT NULL AND t.seq < ?
        ORDER BY t.seq DESC LIMIT 26`,
        )
        .all(id, before);
      const queued = db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status = 'queued'",
        )
        .get(id)!;
      return {
        quota: settings(id).quota,
        queued: Number(queued.n),
        today: totals(
          id,
          Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate(),
          ),
        ),
        month: totals(
          id,
          Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
        ),
        tasks: rows.slice(0, 25).map((row) => ({
          id: String(row.id),
          startedAt: Number(row.started_at),
          status: String(row.status),
          origin: String(row.origin),
          scheduleName:
            typeof row.schedule_name === "string" ? row.schedule_name : null,
          usage: readJson<TaskUsage>(row.usage),
        })),
        next: rows.length > 25 ? Number(rows[24]!.seq) : null,
      };
    },
    close() {
      db.close();
    },
  };
}

export function createHostUsage(
  resolve: (agentId: string) => Promise<AgentHostConfig>,
  request = fetch,
) {
  async function call(agentId: string, path: string, body?: object) {
    const host = await resolve(agentId);
    const response = await request(`${host.url}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${host.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(body ? 35_000 : 12_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Agent model information unavailable");
    return (await response.json()) as unknown;
  }
  return {
    async models(agentId: string) {
      return modelCatalog.parse(await call(agentId, "/models")).models;
    },
    async check(agentId: string, model: ModelReference | null, issue: boolean) {
      return modelCheck.parse(
        await call(agentId, "/models/check", { model, issue }),
      );
    },
    async recover(agentId: string, hostTaskId: string) {
      const raw = await call(
        agentId,
        `/tasks/${encodeURIComponent(hostTaskId)}/usage`,
      );
      if (
        !raw ||
        typeof raw !== "object" ||
        !("usage" in raw) ||
        raw.usage === null
      )
        return null;
      return taskUsage.parse(raw.usage);
    },
  };
}

export function createAgentUsage(
  store: ReturnType<typeof openAgentUsage>,
  host: ReturnType<typeof createHostUsage>,
) {
  const refreshing = new Set<string>();
  const attempts = new Map<string, number>();
  async function check(id: string, issue: boolean) {
    const { selected, revision, quota: previous } = store.settings(id);
    const checkedAt = Date.now();
    const response = await host.check(id, selected, issue).catch(() => ({
      model: selected,
      state: "checking" as const,
      checkedAt,
      failure: "host_unavailable" as const,
      windows: [],
      admission: undefined,
    }));
    const quota = quotaStatus.parse(response);
    if (
      quota.state === "checking" &&
      previous?.windows.some((item) => item.exhausted)
    ) {
      quota.model = previous.model;
      quota.windows = previous.windows;
    }
    const latest = store.settings(id);
    if (store.saveQuota(id, revision, quota)) {
      if (quota.failure && quota.failure !== latest.quota?.failure)
        log.warn("agent.model_check_failed", {
          agentId: id,
          reason: quota.failure,
        });
    } else if (latest.revision !== revision) return undefined;
    return quota.state === "available" || quota.state === "unavailable"
      ? response.admission
      : undefined;
  }
  return {
    async models(id: string) {
      const models = await host.models(id).catch(() => null);
      return {
        selected: store.settings(id).selected,
        models: models ?? [],
        catalogAvailable: models !== null,
      };
    },
    async setModel(id: string, model: ModelReference | null) {
      if (model) {
        const models = await host.models(id);
        if (
          !models.some(
            (entry) =>
              entry.providerId === model.providerId &&
              entry.modelId === model.modelId,
          )
        )
          return false;
      }
      store.setModel(id, model);
      attempts.delete(id);
      return true;
    },
    invalidate(id: string) {
      store.invalidate(id);
      attempts.delete(id);
    },
    prepare: (id: string) => check(id, true),
    report(id: string, before?: number) {
      return store.report(id, before);
    },
    refresh(id: string) {
      const now = Date.now();
      const at = Math.max(
        store.settings(id).quota?.checkedAt ?? 0,
        attempts.get(id) ?? 0,
      );
      if (refreshing.has(id) || now - at < 30_000) return;
      attempts.set(id, now);
      refreshing.add(id);
      void check(id, false)
        .catch(() => {})
        .finally(() => refreshing.delete(id));
    },
    record: store.record,
    async recover() {
      for (const { agentId, id, hostTaskId } of store.pendingRecovery()) {
        const usage = await host.recover(agentId, hostTaskId).catch(() => null);
        if (usage) store.record(agentId, id, hostTaskId, usage);
      }
    },
  };
}
