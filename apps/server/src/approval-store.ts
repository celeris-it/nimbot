import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const APPROVAL_LIMITS = {
  summary: 300,
  target: 300,
  actionType: 64,
  actor: 128,
  pageSize: 50,
  /** Pending requests one task may hold at once. */
  pendingPerTask: 10,
} as const;

export type ApprovalStatus =
  "pending" | "approved" | "denied" | "expired" | "cancelled";
export type ExecutionStatus =
  "not_started" | "started" | "completed" | "failed" | "uncertain";

export interface ApprovalRequest {
  id: string;
  agentId: string;
  taskId: string;
  /** Who started the task, e.g. "telegram:123:42"; never model text. */
  origin: string;
  actor: string;
  actionType: string;
  target: string;
  summary: string;
  fingerprint: string;
  status: ApprovalStatus;
  decidedBy: string | null;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  execution: ExecutionStatus;
  executionNote: string | null;
}

export interface ApprovalInput {
  agentId: string;
  taskId: string;
  origin: string;
  actor: string;
  /** Trusted operation identifier, e.g. "mcp.github.create_issue". */
  actionType: string;
  /** Normalized exact target the approval applies to. */
  target: string;
  /** Free text for the human; stored bounded and redacted. */
  summary: string;
  /** Exact arguments being approved; only their digest is stored. */
  arguments: unknown;
  ttlMs: number;
}

/** Removes obvious credentials from text that will be shown or stored. */
export function redactSummary(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|token|secret|password|passwd|authorization)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
      "$1$2[redacted]",
    )
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, APPROVAL_LIMITS.summary);
}

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 20) throw new Error("Invalid approval arguments");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value))
    return value.map((item) => canonical(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key], depth + 1),
        ]),
    );
  throw new Error("Invalid approval arguments");
}

/** Digest of the exact action: any change to it needs a new decision. */
export function actionFingerprint(
  agentId: string,
  actionType: string,
  target: string,
  args: unknown,
): string {
  return createHash("sha256")
    .update(JSON.stringify([agentId, actionType, target, canonical(args)]))
    .digest("hex");
}

const IDENT = /^[a-z][a-z0-9_.:-]*$/;
const COLUMNS = `id, agent_id, task_id, origin, actor, action_type, target, summary, fingerprint,
  status, decided_by, created_at, expires_at, decided_at, execution, execution_note`;

function row(r: Record<string, unknown>): ApprovalRequest {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    taskId: String(r.task_id),
    origin: String(r.origin),
    actor: String(r.actor),
    actionType: String(r.action_type),
    target: String(r.target),
    summary: String(r.summary),
    fingerprint: String(r.fingerprint),
    status: r.status as ApprovalStatus,
    decidedBy: typeof r.decided_by === "string" ? r.decided_by : null,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    decidedAt: r.decided_at === null ? null : Number(r.decided_at),
    execution: r.execution as ExecutionStatus,
    executionNote:
      typeof r.execution_note === "string" ? r.execution_note : null,
  };
}

/**
 * Structured approval requests and decisions. Every transition is a single
 * conditional UPDATE, so concurrent clicks, expiry and cancellation cannot both
 * win. Approval and execution are tracked separately: an approval alone is not
 * a completed action, and an interrupted execution is never replayed.
 */
export function openApprovalStore(path: string, now: () => number = Date.now) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      actor TEXT NOT NULL,
      action_type TEXT NOT NULL,
      target TEXT NOT NULL,
      summary TEXT NOT NULL,
      fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
      decided_by TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      decided_at INTEGER,
      execution TEXT NOT NULL DEFAULT 'not_started' CHECK(execution IN ('not_started', 'started', 'completed', 'failed', 'uncertain')),
      execution_note TEXT,
      CHECK (execution = 'not_started' OR status = 'approved')
    )`);
    db.exec(
      "CREATE INDEX IF NOT EXISTS approval_requests_agent ON approval_requests (agent_id, created_at DESC)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS approval_requests_task ON approval_requests (task_id, status)",
    );
    // A restart cannot prove what a pending request or started execution did.
    db.prepare(
      "UPDATE approval_requests SET status = 'denied', decided_by = 'system:restart', decided_at = ? WHERE status = 'pending'",
    ).run(now());
    db.prepare(
      "UPDATE approval_requests SET execution = 'uncertain', execution_note = 'interrupted by restart' WHERE execution = 'started'",
    ).run();
  } catch (error) {
    db.close();
    throw error;
  }
  const get = (id: string) => {
    const r = db
      .prepare(`SELECT ${COLUMNS} FROM approval_requests WHERE id = ?`)
      .get(id);
    return r ? row(r) : undefined;
  };
  return {
    create(input: ApprovalInput): ApprovalRequest {
      if (
        !IDENT.test(input.actionType) ||
        input.actionType.length > APPROVAL_LIMITS.actionType ||
        !input.target ||
        input.target.length > APPROVAL_LIMITS.target ||
        !input.actor ||
        input.actor.length > APPROVAL_LIMITS.actor ||
        !input.origin ||
        input.origin.length > APPROVAL_LIMITS.actor ||
        !Number.isSafeInteger(input.ttlMs) ||
        input.ttlMs < 1 ||
        input.ttlMs > 86_400_000
      )
        throw new Error("Invalid approval request");
      const pending = Number(
        db
          .prepare(
            "SELECT count(*) AS n FROM approval_requests WHERE task_id = ? AND status = 'pending'",
          )
          .get(input.taskId)!.n,
      );
      if (pending >= APPROVAL_LIMITS.pendingPerTask)
        throw new Error("Too many pending approvals");
      const at = now();
      const id = randomUUID();
      db.prepare(
        `INSERT INTO approval_requests (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, 'not_started', NULL)`,
      ).run(
        id,
        input.agentId,
        input.taskId,
        input.origin,
        input.actor,
        input.actionType,
        input.target,
        redactSummary(input.summary),
        actionFingerprint(
          input.agentId,
          input.actionType,
          input.target,
          input.arguments,
        ),
        at,
        at + input.ttlMs,
      );
      return get(id)!;
    },
    get,
    /** Only a pending, unexpired request can be decided, and only once. */
    decide(id: string, approve: boolean, decidedBy: string): boolean {
      return (
        db
          .prepare(
            "UPDATE approval_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?",
          )
          .run(
            approve ? "approved" : "denied",
            decidedBy.slice(0, APPROVAL_LIMITS.actor),
            now(),
            id,
            now(),
          ).changes === 1
      );
    },
    /** Marks overdue pending requests expired; returns how many. */
    expireDue(): number {
      return Number(
        db
          .prepare(
            "UPDATE approval_requests SET status = 'expired', decided_by = 'system:expiry', decided_at = ? WHERE status = 'pending' AND expires_at <= ?",
          )
          .run(now(), now()).changes,
      );
    },
    /** Task ended or was cancelled: unresolved requests are cancelled. */
    cancelForTask(taskId: string): number {
      return Number(
        db
          .prepare(
            "UPDATE approval_requests SET status = 'cancelled', decided_by = 'system:task_ended', decided_at = ? WHERE task_id = ? AND status = 'pending'",
          )
          .run(now(), taskId).changes,
      );
    },
    /** Denies a pending request that could not be delivered to the owner. */
    failDelivery(id: string): boolean {
      return (
        db
          .prepare(
            "UPDATE approval_requests SET status = 'denied', decided_by = 'system:delivery_failed', decided_at = ? WHERE id = ? AND status = 'pending'",
          )
          .run(now(), id).changes === 1
      );
    },
    /**
     * The single gate before a side effect: succeeds once, only for an approved,
     * unexpired request whose fingerprint still matches the action about to run.
     */
    beginExecution(id: string, fingerprint: string): boolean {
      return (
        db
          .prepare(
            "UPDATE approval_requests SET execution = 'started' WHERE id = ? AND status = 'approved' AND execution = 'not_started' AND fingerprint = ? AND expires_at > ?",
          )
          .run(id, fingerprint, now()).changes === 1
      );
    },
    finishExecution(
      id: string,
      outcome: "completed" | "failed" | "uncertain",
      note?: string,
    ): boolean {
      return (
        db
          .prepare(
            "UPDATE approval_requests SET execution = ?, execution_note = ? WHERE id = ? AND execution = 'started'",
          )
          .run(outcome, note ? redactSummary(note) : null, id).changes === 1
      );
    },
    /** Newest first, one bounded page per agent for the panel history. */
    listByAgent(
      agentId: string,
      page = 1,
    ): { requests: ApprovalRequest[]; hasMore: boolean } {
      const size = APPROVAL_LIMITS.pageSize;
      const rows = db
        .prepare(
          `SELECT ${COLUMNS} FROM approval_requests WHERE agent_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
        )
        .all(agentId, size + 1, (Math.max(1, Math.floor(page)) - 1) * size);
      return {
        requests: rows.slice(0, size).map(row),
        hasMore: rows.length > size,
      };
    },
    close() {
      db.close();
    },
  };
}
export type ApprovalStore = ReturnType<typeof openApprovalStore>;
