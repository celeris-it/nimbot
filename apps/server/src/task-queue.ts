import type {
  DiscordAttachmentInput,
  DiscordDocument,
} from "./discord-attachments.js";
import type { TelegramDocument } from "./telegram-attachments.js";
import { isDiscordId } from "./discord-identity.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HostModelAdmissionExpired, HostTaskError } from "./host/host-tasks.js";
import { log as defaultLog, type Logger } from "./logger.js";

export type TaskStatus =
  "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";

export interface QueuedTask {
  id: string;
  agentId: string;
  botId: number;
  chatId: number;
  prompt: string;
  telegramDocument?: TelegramDocument;
  replyDocumentId?: number;
  scheduleId?: string;
  scheduleName?: string;
  scheduledFor?: number;
}

export interface DiscordConversation {
  platform: "discord";
  botId: string;
  ownerId: string;
  channelId: string;
}

export interface DiscordDestination {
  agentId: string;
  origin: DiscordConversation;
}

export interface DiscordQueuedTask extends DiscordDestination {
  id: string;
  prompt: string;
  origin: DiscordConversation & { messageId?: string };
  discordAttachment?: DiscordAttachmentInput;
  scheduleId?: string;
  scheduleName?: string;
  scheduledFor?: number;
}
export type ChatTask = (
  | DiscordQueuedTask
  | (QueuedTask & {
      origin: { platform: "telegram"; botId: number; chatId: number };
    })
) & { scheduleId?: string; scheduleName?: string; scheduledFor?: number };
export interface DelegatedTask {
  id: string;
  agentId: string;
  prompt: string;
  origin: {
    platform: "delegated";
    delegationId: string;
    parentTaskId: string;
    sourceAgentId: string;
  };
}
export type RoutedTask = (ChatTask | DelegatedTask) & {
  scheduleId?: string;
  scheduleName?: string;
  scheduledFor?: number;
};
export const DELEGATION_LIMITS = {
  perParent: 3,
  brief: 2_000,
  resultBytes: 8_192,
} as const;
export interface Delegation {
  id: string;
  sourceTaskId: string;
  sourceAgentId: string;
  targetAgentId: string;
  invocationId: string;
  brief: string;
  state: "pending" | "admitted" | "discarded";
  childTaskId: string | null;
  reason: string | null;
  createdAt: number;
  childStatus?: TaskStatus;
  cancellationRequested?: true;
  /** Untrusted output from the child; never permission or instructions for the requester. */
  result?: DelegationResult;
}
export interface DelegationHistoryEntry {
  id: string;
  targetAgentId: string;
  sourceTaskId: string;
  childTaskId: string | null;
  briefPreview: string;
  status: TaskStatus | "pending" | "discarded" | "unavailable";
  reason: string | null;
  createdAt: number;
  cancellationRequested: boolean;
  canCancel: boolean;
}
type DelegationPolicy = (parent: ChatTask, targetAgentId: string) => boolean;

export type TaskOutcome =
  | { ok: true; output: string }
  | { ok: false; kind: HostTaskError["kind"] | "not_ready" };

export type DelegationResult =
  | { ok: true; output: string; truncated: boolean }
  | Extract<TaskOutcome, { ok: false }>;
const failureKinds = new Set([
  "busy",
  "unavailable",
  "failed",
  "interrupted",
  "timeout",
  "cancelled",
  "not_ready",
  "attachment_unavailable",
]);
function encodeDelegationResult(
  status: TaskStatus,
  outcome?: TaskOutcome,
): string {
  if (status !== "completed") {
    const kind =
      status === "cancelled" || status === "interrupted"
        ? status
        : outcome?.ok === false &&
            failureKinds.has(outcome.kind) &&
            outcome.kind !== "cancelled" &&
            outcome.kind !== "interrupted"
          ? outcome.kind
          : "failed";
    return JSON.stringify({ ok: false, kind });
  }
  if (outcome?.ok !== true || typeof outcome.output !== "string")
    throw new Error("Completed child result is missing");
  let output = "";
  let truncated = false;
  let bytes = Buffer.byteLength(
    JSON.stringify({ ok: true, output, truncated }),
  );
  // Count serialized bytes, including JSON escapes, without splitting a Unicode code point.
  for (const character of outcome.output) {
    const size = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + size > DELEGATION_LIMITS.resultBytes) {
      truncated = true;
      break;
    }
    output += character;
    bytes += size;
  }
  return JSON.stringify({ ok: true, output, truncated });
}
function readDelegationResult(
  value: unknown,
  status: unknown,
): DelegationResult | undefined {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > DELEGATION_LIMITS.resultBytes
  )
    return undefined;
  try {
    const result = JSON.parse(value) as Record<string, unknown>;
    if (!result || typeof result !== "object" || Array.isArray(result))
      return undefined;
    if (
      status === "completed" &&
      result.ok === true &&
      typeof result.output === "string" &&
      typeof result.truncated === "boolean" &&
      Object.keys(result).length === 3
    )
      return { ok: true, output: result.output, truncated: result.truncated };
    if (
      ["failed", "cancelled", "interrupted"].includes(String(status)) &&
      result.ok === false &&
      typeof result.kind === "string" &&
      failureKinds.has(result.kind) &&
      (status !== "cancelled" || result.kind === "cancelled") &&
      (status !== "interrupted" || result.kind === "interrupted") &&
      (status !== "failed" ||
        (result.kind !== "cancelled" && result.kind !== "interrupted")) &&
      Object.keys(result).length === 2
    )
      return {
        ok: false,
        kind: result.kind as Extract<TaskOutcome, { ok: false }>["kind"],
      };
  } catch {
    /* Malformed stored output is never returned as context. */
  }
  return undefined;
}

/** Chat results stay on the Host; bounded delegation results are retained here. Bot tokens never enter this database. */
export function openTaskStore(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'telegram' CHECK(platform IN ('telegram', 'discord', 'delegated')),
      bot_id INTEGER,
      chat_id INTEGER,
      discord_bot_id TEXT,
      discord_owner_id TEXT,
      discord_channel_id TEXT,
      discord_message_id TEXT,
      discord_attachment TEXT,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      update_id INTEGER,
      telegram_document TEXT,
      telegram_document_id INTEGER,
      reply_document_id INTEGER,
      attachment_saved INTEGER NOT NULL DEFAULT 0,
      schedule_id TEXT,
      schedule_name TEXT,
      scheduled_for INTEGER,
      schedule_trigger TEXT CHECK(schedule_trigger IN ('schedule', 'webhook')),
      host_task_id TEXT,
      delegation_id TEXT,
      parent_task_id TEXT,
      source_agent_id TEXT,
      CHECK ((schedule_id IS NULL AND scheduled_for IS NULL) OR
        (schedule_id IS NOT NULL AND scheduled_for IS NOT NULL AND platform IN ('telegram', 'discord'))),
      CHECK ((platform = 'telegram' AND bot_id IS NOT NULL AND chat_id IS NOT NULL AND discord_bot_id IS NULL AND discord_owner_id IS NULL AND discord_channel_id IS NULL AND discord_message_id IS NULL)
        OR (platform = 'discord' AND bot_id IS NULL AND chat_id IS NULL AND update_id IS NULL AND discord_bot_id IS NOT NULL AND discord_owner_id IS NOT NULL AND discord_channel_id IS NOT NULL AND ((schedule_id IS NULL AND discord_message_id IS NOT NULL) OR (schedule_id IS NOT NULL AND discord_message_id IS NULL)))
        OR (platform = 'delegated' AND bot_id IS NULL AND chat_id IS NULL AND update_id IS NULL AND discord_bot_id IS NULL AND discord_owner_id IS NULL AND discord_channel_id IS NULL AND discord_message_id IS NULL)),
      CHECK ((platform = 'delegated' AND delegation_id IS NOT NULL AND parent_task_id IS NOT NULL AND source_agent_id IS NOT NULL AND source_agent_id != agent_id AND parent_task_id != id AND schedule_id IS NULL AND schedule_name IS NULL AND scheduled_for IS NULL)
        OR (platform != 'delegated' AND delegation_id IS NULL AND parent_task_id IS NULL AND source_agent_id IS NULL))
    )`);
    db.exec(
      "CREATE INDEX IF NOT EXISTS tasks_agent_queue ON tasks (agent_id, status, seq)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS tasks_schedule_outcomes ON tasks (agent_id, schedule_id, status, seq) WHERE schedule_id IS NOT NULL",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS tasks_telegram_document ON tasks (agent_id, bot_id, chat_id, telegram_document_id) WHERE telegram_document_id IS NOT NULL",
    );
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS tasks_delegation ON tasks (delegation_id) WHERE delegation_id IS NOT NULL",
    );
    db.exec(`CREATE TABLE IF NOT EXISTS delegations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source_task_id TEXT NOT NULL, source_agent_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
      brief TEXT NOT NULL CHECK(length(brief) BETWEEN 1 AND ${DELEGATION_LIMITS.brief}),
      state TEXT NOT NULL CHECK(state IN ('pending', 'admitted', 'discarded')),
      child_task_id TEXT UNIQUE, reason TEXT,
      cancel_requested_at INTEGER CHECK(cancel_requested_at IS NULL OR state = 'admitted'),
      result_json TEXT CHECK(result_json IS NULL OR (state = 'admitted' AND length(CAST(result_json AS BLOB)) <= ${DELEGATION_LIMITS.resultBytes})),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(source_task_id, invocation_id), CHECK(source_agent_id != target_agent_id),
      CHECK((state = 'admitted' AND child_task_id IS NOT NULL AND reason IS NULL)
        OR (state = 'pending' AND child_task_id IS NULL AND reason IS NULL)
        OR (state = 'discarded' AND child_task_id IS NULL AND reason IS NOT NULL))
    ); CREATE INDEX IF NOT EXISTS delegations_parent ON delegations(source_task_id, state, seq);
    CREATE INDEX IF NOT EXISTS delegations_source_history ON delegations(source_agent_id, seq);
    CREATE INDEX IF NOT EXISTS delegations_source_results ON delegations(source_agent_id, seq)
      WHERE state = 'admitted' AND result_json IS NOT NULL`);
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS tasks_host_identity ON tasks (agent_id, host_task_id) WHERE host_task_id IS NOT NULL",
    );
    // Update IDs are only unique per bot, so the pair identifies one message.
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS tasks_update ON tasks (bot_id, update_id) WHERE update_id IS NOT NULL",
    );
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS tasks_discord_message ON tasks (discord_bot_id, discord_message_id) WHERE platform = 'discord'",
    );
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS tasks_schedule_occurrence ON tasks (schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL",
    );
    // Durable write replay protection for Server-side tool operations.
    db.exec(`CREATE TABLE IF NOT EXISTS tool_invocations (
      task_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, invocation_id)
    )`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* No active transaction. */
    }
    db.close();
    throw error;
  }
  const columns =
    "id, agent_id AS agentId, bot_id AS botId, chat_id AS chatId, prompt, schedule_id AS scheduleId, schedule_name AS scheduleName, scheduled_for AS scheduledFor, delegation_id, parent_task_id, source_agent_id, telegram_document, reply_document_id, discord_attachment";
  function scheduleMetadata(row: Record<string, unknown>) {
    return row.scheduleId == null
      ? {}
      : {
          scheduleId: String(row.scheduleId),
          ...(row.scheduleName == null
            ? {}
            : { scheduleName: String(row.scheduleName) }),
          scheduledFor: Number(row.scheduledFor),
        };
  }
  function routed(row: Record<string, unknown>): RoutedTask {
    const base = {
      id: String(row.id),
      agentId: String(row.agentId),
      prompt: String(row.prompt),
      ...scheduleMetadata(row),
    };
    if (row.platform === "delegated")
      return {
        ...base,
        origin: {
          platform: "delegated",
          delegationId: String(row.delegation_id),
          parentTaskId: String(row.parent_task_id),
          sourceAgentId: String(row.source_agent_id),
        },
      };
    if (row.platform === "discord")
      return {
        ...base,
        ...(typeof row.discord_attachment === "string"
          ? {
              discordAttachment: JSON.parse(
                row.discord_attachment,
              ) as DiscordAttachmentInput,
            }
          : {}),
        origin: {
          platform: "discord",
          botId: String(row.discord_bot_id),
          ownerId: String(row.discord_owner_id),
          channelId: String(row.discord_channel_id),
          ...(typeof row.discord_message_id === "string"
            ? { messageId: row.discord_message_id }
            : {}),
        },
      };
    return {
      ...base,
      botId: Number(row.botId),
      chatId: Number(row.chatId),
      ...(typeof row.telegram_document === "string"
        ? {
            telegramDocument: JSON.parse(
              row.telegram_document,
            ) as TelegramDocument,
          }
        : {}),
      ...(typeof row.reply_document_id === "number"
        ? { replyDocumentId: row.reply_document_id }
        : {}),
      origin: {
        platform: "telegram",
        botId: Number(row.botId),
        chatId: Number(row.chatId),
      },
    };
  }
  function nextTask(agentId: string): RoutedTask | undefined {
    const row = db
      .prepare(
        `SELECT ${columns}, platform, discord_bot_id, discord_owner_id, discord_channel_id, discord_message_id FROM tasks
        WHERE agent_id = ? AND status = 'queued'
          AND NOT EXISTS (SELECT 1 FROM tasks busy WHERE busy.agent_id = ? AND busy.status = 'running')
        ORDER BY seq LIMIT 1`,
      )
      .get(agentId, agentId);
    return row ? routed(row) : undefined;
  }
  function claim(
    agentId: string,
    telegramOnly: boolean,
    ready?: (task: RoutedTask) => boolean,
  ): RoutedTask | undefined {
    db.exec("BEGIN IMMEDIATE");
    try {
      const head = nextTask(agentId);
      const task =
        head && (!telegramOnly || head.origin.platform === "telegram")
          ? head
          : undefined;
      if (task && ready && !ready(task)) {
        db.exec("COMMIT");
        return undefined;
      }
      if (task)
        db.prepare(
          "UPDATE tasks SET status = 'running', updated_at = ?, started_at = ? WHERE id = ?",
        ).run(Date.now(), Date.now(), task.id);
      db.exec("COMMIT");
      return task;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const readDelegation = (row: Record<string, unknown>): Delegation => {
    const result = readDelegationResult(row.result_json, row.child_status);
    return {
      id: String(row.id),
      sourceTaskId: String(row.source_task_id),
      sourceAgentId: String(row.source_agent_id),
      targetAgentId: String(row.target_agent_id),
      invocationId: String(row.invocation_id),
      brief: String(row.brief),
      state: row.state as Delegation["state"],
      childTaskId:
        typeof row.child_task_id === "string" ? row.child_task_id : null,
      reason: typeof row.reason === "string" ? row.reason : null,
      createdAt: Number(row.created_at),
      ...(typeof row.child_status === "string"
        ? { childStatus: row.child_status as TaskStatus }
        : {}),
      ...(result ? { result } : {}),
      ...(typeof row.cancel_requested_at === "number"
        ? { cancellationRequested: true as const }
        : {}),
    };
  };
  const parentRow = (id: string) =>
    db
      .prepare(
        `SELECT ${columns}, platform, discord_bot_id, discord_owner_id, discord_channel_id, discord_message_id, status FROM tasks WHERE id = ?`,
      )
      .get(id);
  function finishWithDelegations(
    id: string,
    status: "completed" | "failed" | "interrupted" | "cancelled",
    allowed: DelegationPolicy,
    cancelled = false,
    outcome?: TaskOutcome,
  ): string[] {
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = parentRow(id);
      if (!row || row.status !== "running") {
        db.exec("COMMIT");
        return [];
      }
      const parent = routed(row);
      const cancellationRequested =
        parent.origin.platform === "delegated" &&
        db
          .prepare(
            "SELECT cancel_requested_at FROM delegations WHERE id = ? AND child_task_id = ?",
          )
          .get(parent.origin.delegationId, parent.id)?.cancel_requested_at !=
          null;
      const terminalStatus =
        parent.origin.platform === "delegated" &&
        (cancelled || cancellationRequested)
          ? "cancelled"
          : status;
      db.prepare(
        "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'running'",
      ).run(terminalStatus, Date.now(), id);
      if (parent.origin.platform === "delegated") {
        const saved = db
          .prepare(
            `UPDATE delegations SET result_json = ?, updated_at = ? WHERE id = ? AND state = 'admitted'
          AND child_task_id = ? AND source_task_id = ? AND source_agent_id = ? AND target_agent_id = ? AND result_json IS NULL`,
          )
          .run(
            encodeDelegationResult(terminalStatus, outcome),
            Date.now(),
            parent.origin.delegationId,
            parent.id,
            parent.origin.parentTaskId,
            parent.origin.sourceAgentId,
            parent.agentId,
          );
        if (saved.changes !== 1)
          throw new Error("Child result correlation is unavailable");
      }
      const targets = new Set<string>();
      for (const entry of db
        .prepare(
          "SELECT * FROM delegations WHERE source_task_id = ? AND state = 'pending' ORDER BY seq",
        )
        .all(id)) {
        const target = String(entry.target_agent_id);
        if (
          cancelled ||
          status !== "completed" ||
          parent.origin.platform === "delegated" ||
          parent.scheduleId !== undefined ||
          !allowed(parent as ChatTask, target)
        ) {
          db.prepare(
            "UPDATE delegations SET state = 'discarded', reason = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
          ).run(
            cancelled
              ? "parent_cancelled"
              : status !== "completed"
                ? `parent_${status}`
                : "access_revoked",
            Date.now(),
            String(entry.id),
          );
          continue;
        }
        const child = randomUUID();
        const now = Date.now();
        db.prepare(
          `INSERT INTO tasks (id, agent_id, platform, prompt, status, created_at, updated_at, delegation_id, parent_task_id, source_agent_id)
          VALUES (?, ?, 'delegated', ?, 'queued', ?, ?, ?, ?, ?)`,
        ).run(
          child,
          target,
          String(entry.brief),
          now,
          now,
          String(entry.id),
          parent.id,
          parent.agentId,
        );
        db.prepare(
          "UPDATE delegations SET state = 'admitted', child_task_id = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
        ).run(child, now, String(entry.id));
        targets.add(target);
      }
      db.exec("COMMIT");
      // The caller may kick workers only after this transaction has committed.
      return [...targets];
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return {
    /** Stages a one-hop brief without enqueuing any work. Identity comes from the saved parent. */
    stageDelegation(
      input: {
        parentTaskId: string;
        targetAgentId: string;
        invocationId: string;
        brief: string;
      },
      allowed: DelegationPolicy,
    ): Delegation {
      const uuid =
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
      if (
        typeof input.parentTaskId !== "string" ||
        typeof input.invocationId !== "string" ||
        typeof input.targetAgentId !== "string" ||
        !uuid.test(input.parentTaskId) ||
        !uuid.test(input.invocationId) ||
        !/^[a-z0-9][a-z0-9-]{0,47}$/.test(input.targetAgentId) ||
        typeof input.brief !== "string" ||
        !input.brief.trim() ||
        input.brief.length > DELEGATION_LIMITS.brief
      )
        throw new Error("Invalid delegation");
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = parentRow(input.parentTaskId);
        const parent = row ? routed(row) : undefined;
        if (
          !parent ||
          row!.status !== "running" ||
          parent.origin.platform === "delegated" ||
          parent.scheduleId !== undefined ||
          parent.agentId === input.targetAgentId ||
          !allowed(parent as ChatTask, input.targetAgentId)
        )
          throw new Error("Delegation is not authorized");
        const existing = db
          .prepare(
            "SELECT * FROM delegations WHERE source_task_id = ? AND invocation_id = ?",
          )
          .get(parent.id, input.invocationId);
        const brief = input.brief.trim();
        if (existing) {
          if (
            existing.target_agent_id !== input.targetAgentId ||
            existing.brief !== brief
          )
            throw new Error("Delegation invocation conflict");
          db.exec("COMMIT");
          return readDelegation(existing);
        }
        if (
          Number(
            db
              .prepare(
                "SELECT count(*) AS n FROM delegations WHERE source_task_id = ?",
              )
              .get(parent.id)!.n,
          ) >= DELEGATION_LIMITS.perParent
        )
          throw new Error("Too many delegations");
        const id = randomUUID();
        const now = Date.now();
        db.prepare(
          "INSERT INTO delegations (id, source_task_id, source_agent_id, target_agent_id, invocation_id, brief, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
        ).run(
          id,
          parent.id,
          parent.agentId,
          input.targetAgentId,
          input.invocationId,
          brief,
          now,
          now,
        );
        const result = readDelegation(
          db.prepare("SELECT * FROM delegations WHERE id = ?").get(id)!,
        );
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    /** Internal lookup only; receiving services must recheck grants and the saved source origin before exposing results. */
    getDelegation(sourceAgentId: string, id: string): Delegation | undefined {
      const row = db
        .prepare(
          `SELECT d.id, d.source_task_id, d.source_agent_id, d.target_agent_id, d.invocation_id, d.brief, d.state, d.child_task_id, d.reason, d.created_at, d.cancel_requested_at,
            CASE WHEN length(CAST(d.result_json AS BLOB)) <= ${DELEGATION_LIMITS.resultBytes} THEN d.result_json ELSE NULL END AS result_json,
            t.status AS child_status FROM delegations d LEFT JOIN tasks t ON d.state = 'admitted' AND t.id = d.child_task_id
            AND t.platform = 'delegated' AND t.delegation_id = d.id AND t.parent_task_id = d.source_task_id
            AND t.agent_id = d.target_agent_id AND t.source_agent_id = d.source_agent_id
            WHERE d.source_agent_id = ? AND d.id = ?`,
        )
        .get(sourceAgentId, id);
      return row ? readDelegation(row) : undefined;
    },
    /** Administrator history excludes parent prompts and child result bodies. */
    listDelegations(
      sourceAgentId: string,
      page = 1,
    ): { delegations: DelegationHistoryEntry[]; hasMore: boolean } {
      const safePage =
        Number.isSafeInteger(page) && page >= 1 && page <= 1000 ? page : 1;
      const rows = db
        .prepare(
          `SELECT d.id, d.source_task_id, d.target_agent_id, substr(d.brief, 1, 160) AS preview,
          d.state, d.reason, d.created_at, d.cancel_requested_at, t.id AS child_id, t.status AS child_status
        FROM delegations d LEFT JOIN tasks t ON d.state = 'admitted' AND t.id = d.child_task_id
          AND t.platform = 'delegated' AND t.delegation_id = d.id AND t.parent_task_id = d.source_task_id
          AND t.source_agent_id = d.source_agent_id AND t.agent_id = d.target_agent_id
        WHERE d.source_agent_id = ? ORDER BY d.seq DESC LIMIT 21 OFFSET ?`,
        )
        .all(sourceAgentId, (safePage - 1) * 20);
      return {
        delegations: rows.slice(0, 20).map((row) => {
          const status =
            row.state === "admitted"
              ? String(row.child_status ?? "unavailable")
              : String(row.state);
          const cancellationRequested = row.cancel_requested_at !== null;
          return {
            id: String(row.id),
            targetAgentId: String(row.target_agent_id),
            sourceTaskId: String(row.source_task_id),
            childTaskId: typeof row.child_id === "string" ? row.child_id : null,
            briefPreview: String(row.preview),
            status: status as DelegationHistoryEntry["status"],
            reason:
              typeof row.reason === "string" ? row.reason.slice(0, 96) : null,
            createdAt: Number(row.created_at),
            cancellationRequested,
            canCancel:
              row.state === "admitted" &&
              ["queued", "running"].includes(status) &&
              !cancellationRequested,
          };
        }),
        hasMore: rows.length > 20,
      };
    },
    /** Administrator cancellation, scoped to an exact destination and admitted child. Commit before aborting the runtime. */
    cancelDelegation(
      targetAgentId: string,
      id: string,
    ): { task: RoutedTask; status: "queued" | "running" } | undefined {
      db.exec("BEGIN IMMEDIATE");
      try {
        const handoff = db
          .prepare(
            "SELECT * FROM delegations WHERE id = ? AND target_agent_id = ? AND state = 'admitted'",
          )
          .get(id, targetAgentId);
        const row =
          typeof handoff?.child_task_id === "string"
            ? parentRow(handoff.child_task_id)
            : undefined;
        const child = row ? routed(row) : undefined;
        if (
          !handoff ||
          !row ||
          !child ||
          !["queued", "running"].includes(String(row.status)) ||
          child.agentId !== targetAgentId ||
          child.origin.platform !== "delegated" ||
          child.origin.delegationId !== id ||
          child.origin.sourceAgentId !== handoff.source_agent_id ||
          child.origin.parentTaskId !== handoff.source_task_id
        ) {
          db.exec("COMMIT");
          return undefined;
        }
        if (handoff.result_json !== null)
          throw new Error("Child outcome is already recorded");
        const now = Date.now();
        db.prepare(
          "UPDATE delegations SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ? WHERE id = ?",
        ).run(now, now, id);
        if (row.status === "queued") {
          db.prepare(
            "UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'",
          ).run(now, child.id);
          db.prepare(
            "UPDATE delegations SET result_json = ? WHERE id = ? AND result_json IS NULL",
          ).run(encodeDelegationResult("cancelled"), id);
        }
        db.exec("COMMIT");
        return { task: child, status: row.status as "queued" | "running" };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    /** A deleted target cannot run queued children. Preserve prior results and never classify running work as unexecuted. */
    failQueuedDelegations(targetAgentId: string): number {
      db.exec("BEGIN IMMEDIATE");
      try {
        const now = Date.now();
        const result = encodeDelegationResult("failed", {
          ok: false,
          kind: "not_ready",
        });
        db.prepare(
          `UPDATE delegations SET result_json = ?, updated_at = ?
          WHERE target_agent_id = ? AND state = 'admitted' AND result_json IS NULL
          AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = delegations.child_task_id AND t.status = 'queued'
            AND t.platform = 'delegated' AND t.agent_id = delegations.target_agent_id
            AND t.delegation_id = delegations.id AND t.parent_task_id = delegations.source_task_id
            AND t.source_agent_id = delegations.source_agent_id)`,
        ).run(result, now, targetAgentId);
        const changed = db
          .prepare(
            `UPDATE tasks SET status = 'failed', updated_at = ?
          WHERE agent_id = ? AND status = 'queued' AND platform = 'delegated'
          AND EXISTS (SELECT 1 FROM delegations d WHERE d.child_task_id = tasks.id AND d.state = 'admitted'
            AND d.target_agent_id = tasks.agent_id AND d.id = tasks.delegation_id
            AND d.source_task_id = tasks.parent_task_id AND d.source_agent_id = tasks.source_agent_id
            AND d.result_json = ?)`,
          )
          .run(now, targetAgentId, result);
        db.exec("COMMIT");
        return Number(changed.changes);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    /** Recovery after commit but before a target worker was kicked. Never resumes running work. */
    pendingDelegationTargets(): string[] {
      return db
        .prepare(
          `SELECT DISTINCT t.agent_id FROM delegations d JOIN tasks t ON t.id = d.child_task_id
        WHERE d.state = 'admitted' AND t.status = 'queued' AND t.platform = 'delegated'
        AND t.delegation_id = d.id AND t.parent_task_id = d.source_task_id
        AND t.source_agent_id = d.source_agent_id AND t.agent_id = d.target_agent_id ORDER BY t.agent_id`,
        )
        .all()
        .map((row) => String(row.agent_id));
    },
    /** Result recovery discovers identities only; delivery rechecks the grant, origin and bounded result. */
    delegationResultSources(): string[] {
      return db
        .prepare(
          `SELECT DISTINCT d.source_agent_id FROM delegations d JOIN tasks t ON t.id = d.child_task_id
        WHERE d.state = 'admitted' AND d.result_json IS NOT NULL AND t.status IN ('completed', 'failed', 'cancelled', 'interrupted')
        AND t.platform = 'delegated' AND t.delegation_id = d.id AND t.parent_task_id = d.source_task_id
        AND t.source_agent_id = d.source_agent_id AND t.agent_id = d.target_agent_id ORDER BY d.source_agent_id`,
        )
        .all()
        .map((row) => String(row.source_agent_id));
    },
    /** Keyset pages avoid retaining child outputs or scanning an unbounded history into memory. */
    delegationResultPage(
      sourceAgentId: string,
      after = 0,
    ): { id: string; seq: number }[] {
      if (!Number.isSafeInteger(after) || after < 0)
        throw new Error("Invalid delegation cursor");
      return db
        .prepare(
          `SELECT d.id, d.seq FROM delegations d JOIN tasks t ON t.id = d.child_task_id
        WHERE d.source_agent_id = ? AND d.seq > ? AND d.state = 'admitted' AND d.result_json IS NOT NULL
        AND t.status IN ('completed', 'failed', 'cancelled', 'interrupted') AND t.platform = 'delegated'
        AND t.delegation_id = d.id AND t.parent_task_id = d.source_task_id
        AND t.source_agent_id = d.source_agent_id AND t.agent_id = d.target_agent_id ORDER BY d.seq LIMIT 100`,
        )
        .all(sourceAgentId, after)
        .map((row) => ({ id: String(row.id), seq: Number(row.seq) }));
    },
    /** Rechecks the grant and source origin in the same transaction as parent completion and child admission. */
    finishWithDelegations,
    /**
     * Saves the message before any execution; returns how many tasks are ahead
     * of it. A Telegram update already saved for this bot is reported as a
     * duplicate and creates nothing.
     */
    enqueue(
      task: Omit<
        QueuedTask,
        "id" | "scheduleId" | "scheduleName" | "scheduledFor"
      > & {
        updateId?: number;
      },
    ): {
      id: string;
      ahead: number;
      duplicate: boolean;
    } {
      const id = randomUUID();
      const now = Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        if (task.updateId !== undefined) {
          const existing = db
            .prepare("SELECT id FROM tasks WHERE bot_id = ? AND update_id = ?")
            .get(task.botId, task.updateId) as { id: string } | undefined;
          if (existing) {
            db.exec("COMMIT");
            return { id: existing.id, ahead: 0, duplicate: true };
          }
        }
        const ahead = Number(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status IN ('queued', 'running')",
            )
            .get(task.agentId)!.n,
        );
        db.prepare(
          "INSERT INTO tasks (id, agent_id, bot_id, chat_id, prompt, status, created_at, updated_at, update_id, telegram_document, telegram_document_id, reply_document_id) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)",
        ).run(
          id,
          task.agentId,
          task.botId,
          task.chatId,
          task.prompt,
          now,
          now,
          task.updateId ?? null,
          task.telegramDocument ? JSON.stringify(task.telegramDocument) : null,
          task.telegramDocument?.messageId ?? null,
          task.replyDocumentId ?? null,
        );
        db.exec("COMMIT");
        return { id, ahead, duplicate: false };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    markAttachmentSaved(taskId: string) {
      return (
        db
          .prepare(
            "UPDATE tasks SET attachment_saved = 1 WHERE id = ? AND status = 'running' AND (telegram_document IS NOT NULL OR discord_attachment IS NOT NULL)",
          )
          .run(taskId).changes === 1
      );
    },
    savedTelegramDocument(
      agentId: string,
      botId: number,
      chatId: number,
      messageId: number,
    ) {
      const row = db
        .prepare(
          "SELECT id, telegram_document FROM tasks WHERE agent_id = ? AND bot_id = ? AND chat_id = ? AND telegram_document_id = ? AND attachment_saved = 1 ORDER BY seq LIMIT 1",
        )
        .get(agentId, botId, chatId, messageId);
      if (!row || typeof row.telegram_document !== "string") return undefined;
      const document = JSON.parse(row.telegram_document) as TelegramDocument;
      return `attachments/${String(row.id)}/${document.name}`;
    },
    /** Telegram executor admission stops at a Discord task until routed execution is attached. */
    claimNext(agentId: string): QueuedTask | undefined {
      const task = claim(agentId, true);
      if (!task || task.origin.platform !== "telegram") return undefined;
      return {
        id: task.id,
        agentId: task.agentId,
        prompt: task.prompt,
        botId: task.origin.botId,
        chatId: task.origin.chatId,
        ...(task.scheduleId === undefined
          ? {}
          : {
              scheduleId: task.scheduleId,
              scheduleName: task.scheduleName,
              scheduledFor: task.scheduledFor,
            }),
      };
    },
    claimNextTask(
      agentId: string,
      ready?: (task: RoutedTask) => boolean,
    ): RoutedTask | undefined {
      return claim(agentId, false, ready);
    },
    peekNextTask: nextTask,
    requeueUnaccepted(id: string): boolean {
      return (
        db
          .prepare(
            `UPDATE tasks SET status = 'queued', started_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND host_task_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM delegations d WHERE d.child_task_id = tasks.id AND d.cancel_requested_at IS NOT NULL)`,
          )
          .run(Date.now(), id).changes === 1
      );
    },
    savedDiscordDocument(
      agentId: string,
      origin: DiscordConversation,
      messageId: string,
    ) {
      const row = db
        .prepare(
          `SELECT id, discord_attachment, attachment_saved FROM tasks
        WHERE agent_id = ? AND platform = 'discord' AND discord_bot_id = ?
          AND discord_owner_id = ? AND discord_channel_id = ? AND discord_message_id = ?`,
        )
        .get(
          agentId,
          origin.botId,
          origin.ownerId,
          origin.channelId,
          messageId,
        );
      if (typeof row?.discord_attachment !== "string") return undefined;
      const { document } = JSON.parse(row.discord_attachment) as {
        document?: DiscordDocument;
      };
      if (!document) return undefined;
      return row.attachment_saved === 1
        ? `attachments/${String(row.id)}/${document.name}`
        : null;
    },
    enqueueDiscord(task: Omit<DiscordQueuedTask, "id">) {
      const origin = task.origin;
      const messageId = origin.messageId;
      const attachment = task.discordAttachment
        ? JSON.stringify(task.discordAttachment)
        : null;
      if (
        ![origin.botId, origin.ownerId, origin.channelId].every(isDiscordId) ||
        !isDiscordId(messageId) ||
        (!task.prompt.trim() &&
          !task.discordAttachment?.document &&
          !task.discordAttachment?.error)
      )
        throw new Error("Invalid Discord task");
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db
          .prepare(
            "SELECT id, agent_id, discord_owner_id, discord_channel_id, prompt, discord_attachment FROM tasks WHERE platform = 'discord' AND discord_bot_id = ? AND discord_message_id = ?",
          )
          .get(origin.botId, messageId);
        if (existing) {
          if (
            existing.agent_id !== task.agentId ||
            existing.discord_owner_id !== origin.ownerId ||
            existing.discord_channel_id !== origin.channelId ||
            existing.prompt !== task.prompt ||
            existing.discord_attachment !== attachment
          )
            throw new Error("Discord task identity conflict");
          db.exec("COMMIT");
          return { id: String(existing.id), ahead: 0, duplicate: true };
        }
        const ahead = Number(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status IN ('queued', 'running')",
            )
            .get(task.agentId)!.n,
        );
        const id = randomUUID();
        const now = Date.now();
        db.prepare(
          `INSERT INTO tasks (id, agent_id, platform, discord_bot_id, discord_owner_id, discord_channel_id, discord_message_id, discord_attachment, prompt, status, created_at, updated_at) VALUES (?, ?, 'discord', ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        ).run(
          id,
          task.agentId,
          origin.botId,
          origin.ownerId,
          origin.channelId,
          messageId,
          attachment,
          task.prompt,
          now,
          now,
        );
        db.exec("COMMIT");
        return { id, ahead, duplicate: false };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    /** Binds an accepted Host ID once, only to this agent's running Server task. */
    bindHostTask(agentId: string, taskId: string, hostTaskId: string): boolean {
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          hostTaskId,
        )
      )
        return false;
      try {
        return (
          db
            .prepare(
              `UPDATE tasks SET host_task_id = ?, updated_at = ? WHERE id = ? AND agent_id = ? AND status = 'running' AND (host_task_id IS NULL OR host_task_id = ?)
              AND NOT EXISTS (SELECT 1 FROM delegations d WHERE d.id = tasks.delegation_id AND d.child_task_id = tasks.id AND d.cancel_requested_at IS NOT NULL)`,
            )
            .run(hostTaskId, Date.now(), taskId, agentId, hostTaskId)
            .changes === 1
        );
      } catch {
        // Includes a Host ID already associated with another task of this agent.
        return false;
      }
    },
    /**
     * Records the intent of a write before it runs. A saved outcome is returned on
     * replay; an intent without an outcome means the side effect is uncertain.
     */
    beginToolInvocation(
      taskId: string,
      invocationId: string,
      operation: string,
      argumentsJson: string,
    ):
      | { state: "new" }
      | { state: "uncertain" }
      | { state: "conflict" }
      | { state: "replay"; resultJson: string } {
      const inserted = db
        .prepare(
          "INSERT INTO tool_invocations (task_id, invocation_id, operation, arguments_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .run(taskId, invocationId, operation, argumentsJson, Date.now());
      if (inserted.changes === 1) return { state: "new" };
      const row = db
        .prepare(
          "SELECT operation, arguments_json, result_json FROM tool_invocations WHERE task_id = ? AND invocation_id = ?",
        )
        .get(taskId, invocationId);
      if (
        !row ||
        row.operation !== operation ||
        row.arguments_json !== argumentsJson
      )
        return { state: "conflict" };
      return typeof row.result_json === "string"
        ? { state: "replay", resultJson: row.result_json }
        : { state: "uncertain" };
    },
    settleToolInvocation(
      taskId: string,
      invocationId: string,
      resultJson: string,
    ): void {
      db.prepare(
        "UPDATE tool_invocations SET result_json = ? WHERE task_id = ? AND invocation_id = ? AND result_json IS NULL",
      ).run(resultJson, taskId, invocationId);
    },
    getHostTaskId(agentId: string, taskId: string): string | undefined {
      const row = db
        .prepare("SELECT host_task_id FROM tasks WHERE id = ? AND agent_id = ?")
        .get(taskId, agentId);
      return typeof row?.host_task_id === "string"
        ? row.host_task_id
        : undefined;
    },
    finish(
      id: string,
      status: "completed" | "failed" | "interrupted" | "cancelled",
      outcome?: TaskOutcome,
    ) {
      // Unconfigured callers cannot release a pending handoff.
      finishWithDelegations(id, status, () => false, false, outcome);
    },
    /** A task left running by a stopped server cannot be proven finished. */
    markRunningInterrupted() {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `UPDATE tasks SET status = CASE WHEN platform = 'delegated' AND EXISTS (
            SELECT 1 FROM delegations d WHERE d.id = tasks.delegation_id AND d.child_task_id = tasks.id
            AND d.source_task_id = tasks.parent_task_id AND d.source_agent_id = tasks.source_agent_id
            AND d.target_agent_id = tasks.agent_id AND d.cancel_requested_at IS NOT NULL
          ) THEN 'cancelled' ELSE 'interrupted' END, updated_at = ? WHERE status = 'running'`,
        ).run(Date.now());
        db.prepare(
          `UPDATE delegations SET result_json = CASE WHEN cancel_requested_at IS NOT NULL THEN '{"ok":false,"kind":"cancelled"}' ELSE '{"ok":false,"kind":"interrupted"}' END, updated_at = ?
          WHERE state = 'admitted' AND result_json IS NULL AND child_task_id IN (
            SELECT id FROM tasks WHERE platform = 'delegated' AND
              ((status = 'interrupted' AND delegations.cancel_requested_at IS NULL)
                OR (status = 'cancelled' AND delegations.cancel_requested_at IS NOT NULL))
            AND delegation_id = delegations.id AND parent_task_id = delegations.source_task_id
            AND source_agent_id = delegations.source_agent_id AND agent_id = delegations.target_agent_id
          )`,
        ).run(Date.now());
        db.prepare(
          "UPDATE delegations SET state = 'discarded', reason = 'parent_interrupted', updated_at = ? WHERE state = 'pending' AND source_task_id IN (SELECT id FROM tasks WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted'))",
        ).run(Date.now());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    pendingConversations(agentId: string): { botId: number; chatId: number }[] {
      return db
        .prepare(
          "SELECT DISTINCT bot_id AS botId, chat_id AS chatId FROM tasks WHERE agent_id = ? AND platform = 'telegram' AND status = 'queued'",
        )
        .all(agentId) as unknown as { botId: number; chatId: number }[];
    },
    getTask(id: string): (RoutedTask & { status: TaskStatus }) | undefined {
      const row = db
        .prepare(
          `SELECT ${columns}, platform, discord_bot_id, discord_owner_id, discord_channel_id, discord_message_id, status FROM tasks WHERE id = ?`,
        )
        .get(id);
      return row
        ? { ...routed(row), status: row.status as TaskStatus }
        : undefined;
    },
    get(id: string): (QueuedTask & { status: TaskStatus }) | undefined {
      const row = db
        .prepare(
          `SELECT ${columns}, status FROM tasks WHERE id = ? AND platform = 'telegram'`,
        )
        .get(id);
      if (!row) return undefined;
      return {
        id: String(row.id),
        agentId: String(row.agentId),
        botId: Number(row.botId),
        chatId: Number(row.chatId),
        prompt: String(row.prompt),
        status: row.status as TaskStatus,
        ...scheduleMetadata(row),
      };
    },
    scheduleFailureIncident(
      agentId: string,
      scheduleId: string,
    ): string | undefined {
      const task = db
        .prepare(
          `
        SELECT id FROM tasks
        WHERE agent_id = ? AND schedule_id = ? AND schedule_id IS NOT NULL AND status = 'failed'
          AND seq > COALESCE((
            SELECT MAX(seq) FROM tasks
            WHERE agent_id = ? AND schedule_id = ? AND schedule_id IS NOT NULL AND status = 'completed'
          ), 0)
        ORDER BY seq LIMIT 1 OFFSET 2
      `,
        )
        .get(agentId, scheduleId, agentId, scheduleId);
      return task ? String(task.id) : undefined;
    },
    isScheduleOverlapping(scheduleId: string): boolean {
      return !!db
        .prepare(
          "SELECT 1 FROM tasks WHERE schedule_id = ? AND status IN ('queued', 'running') LIMIT 1",
        )
        .get(scheduleId);
    },
    close() {
      db.close();
    },
  };
}

export type TaskStore = ReturnType<typeof openTaskStore>;

/**
 * Runs one task at a time per agent, oldest first. A failed task never
 * blocks the ones behind it. Delivery retains the originating conversation.
 */
interface QueueConfig<T extends { id: string; prompt: string }> {
  agentId: string;
  claim(): T | undefined;
  prepare?: () => Promise<boolean>;
  requeue?: (task: T) => boolean;
  finish: TaskStore["finish"];
  /** Synchronous durable finalization, with the accepted cancellation signal still available. */
  finalize?: (
    task: T,
    status: Parameters<TaskStore["finish"]>[1],
    signal: AbortSignal,
    outcome: TaskOutcome,
  ) => void;
  conversation(task: T): string;
  execute: (
    task: T,
    report: (message: string) => void,
    cancelSignal: AbortSignal,
  ) => Promise<string>;
  /** Shows a running task's progress to its owner. Best effort. */
  progress?: (task: T, message: string) => Promise<void>;
  /** Minimum time between two progress messages for one task. */
  progressIntervalMs?: number;
  now?: () => number;
  /** Re-checks persisted setup right before a task starts. */
  admit?: (task: T) => boolean;
  deliver: (task: T, outcome: TaskOutcome) => Promise<void>;
  log?: Logger;
}
function createAgentQueue<T extends { id: string; prompt: string }>(
  config: QueueConfig<T>,
) {
  const log = (config.log ?? defaultLog).child({ agentId: config.agentId });
  let closed = false;
  const draining = new Map<string, Promise<void>>();
  const active = new Map<string, AbortController>();
  async function drain() {
    const key = config.agentId;
    // Registered by kick() before this body runs, so the exit below cannot race a submit.
    await Promise.resolve();
    try {
      while (!closed) {
        let task: T | undefined;
        try {
          if (config.prepare && (!(await config.prepare()) || closed)) return;
          task = config.claim();
        } catch {
          return;
        }
        if (!task) return;
        log.info("task.started", { taskId: task.id });
        let outcome: TaskOutcome;
        const controller = new AbortController();
        const conversationKey = config.conversation(task);
        active.set(conversationKey, controller);
        const sending: Promise<unknown>[] = [];
        try {
          if (config.admit && !config.admit(task))
            outcome = { ok: false, kind: "not_ready" };
          else {
            const current = task;
            let lastSent = -Infinity;
            let lastMessage = "";
            // Throttled so a chatty engine cannot flood the chat or hit Telegram limits.
            const report = (message: string) => {
              const now = (config.now ?? Date.now)();
              if (
                !config.progress ||
                message === lastMessage ||
                now - lastSent < (config.progressIntervalMs ?? 5000)
              )
                return;
              lastSent = now;
              lastMessage = message;
              sending.push(config.progress(current, message).catch(() => {}));
            };
            outcome = {
              ok: true,
              output: await config.execute(task, report, controller.signal),
            };
          }
        } catch (error) {
          if (
            error instanceof HostModelAdmissionExpired &&
            !controller.signal.aborted
          ) {
            active.delete(conversationKey);
            if (config.requeue?.(task)) return;
          }
          outcome = {
            ok: false,
            kind: error instanceof HostTaskError ? error.kind : "unavailable",
          };
        }
        active.delete(conversationKey);
        // Progress must reach the chat before the final result does.
        await Promise.allSettled(sending);
        const finalStatus = outcome.ok
          ? "completed"
          : outcome.kind === "interrupted" || outcome.kind === "cancelled"
            ? outcome.kind
            : "failed";
        log[outcome.ok ? "info" : "warn"]("task.finished", {
          taskId: task.id,
          status: finalStatus,
          ...(outcome.ok ? {} : { reason: outcome.kind }),
        });
        let finalized = true;
        try {
          if (config.finalize)
            config.finalize(task, finalStatus, controller.signal, outcome);
          else config.finish(task.id, finalStatus);
        } catch {
          finalized = false;
          /* The store may be closed during shutdown; uncertain work is never replayed. */
        }
        // A child outcome must be committed before it can be published to its requester.
        if (
          !finalized &&
          "origin" in task &&
          (task.origin as { platform?: unknown } | undefined)?.platform ===
            "delegated"
        )
          continue;
        try {
          await config.deliver(task, outcome);
        } catch {
          log.warn("task.delivery_failed", { taskId: task.id });
        }
      }
    } finally {
      // Synchronous with the last claimNext: nothing can enqueue in between.
      draining.delete(key);
    }
  }
  function kick() {
    const key = config.agentId;
    if (closed || draining.has(key)) return;
    draining.set(key, drain());
  }
  return {
    kick,
    isRunning(key: string): boolean {
      const controller = active.get(key);
      return !!controller && !controller.signal.aborted;
    },
    /** Cancels the conversation's running task only; queued tasks behind it still run. */
    stop(key: string): boolean {
      const controller = active.get(key);
      if (!controller || controller.signal.aborted) return false;
      controller.abort();
      return true;
    },
    /** Continues queued work saved before a restart. */
    resume() {
      kick();
    },
    /** Resolves when no conversation is draining; used by tests and orderly shutdown. */
    async idle() {
      while (draining.size) await Promise.all([...draining.values()]);
    },
    close() {
      closed = true;
    },
  };
}

type DeliveryConfig<T extends { id: string; prompt: string }> = Omit<
  QueueConfig<T>,
  "claim" | "finish" | "conversation" | "prepare"
>;

/** Telegram entry point, retained until bot lifecycle uses routed execution. */
export function createTaskQueue(
  config: DeliveryConfig<QueuedTask> & {
    store: Pick<TaskStore, "enqueue" | "claimNext" | "finish">;
  },
) {
  const queue = createAgentQueue({
    ...config,
    claim: () => config.store.claimNext(config.agentId),
    finish: config.store.finish,
    conversation: (task: QueuedTask) => `${task.botId}:${task.chatId}`,
  });
  return {
    ...queue,
    submit(botId: number, chatId: number, prompt: string, updateId?: number) {
      const saved = config.store.enqueue({
        agentId: config.agentId,
        botId,
        chatId,
        prompt,
        ...(updateId === undefined ? {} : { updateId }),
      });
      queue.kick();
      return saved;
    },
    isRunning: (botId: number, chatId: number) =>
      queue.isRunning(`${botId}:${chatId}`),
    stop: (botId: number, chatId: number) => queue.stop(`${botId}:${chatId}`),
  };
}

export function taskOriginKey(origin: RoutedTask["origin"]) {
  if (origin.platform === "delegated")
    return `delegated:${origin.delegationId}`;
  return origin.platform === "telegram"
    ? `telegram:${origin.botId}:${origin.chatId}`
    : `discord:${origin.botId}:${origin.ownerId}:${origin.channelId}`;
}

/** Both platforms use one executor and context; callbacks route using each saved origin. */
export function createRoutedTaskQueue(
  config: DeliveryConfig<RoutedTask> & {
    prepare?: (task: RoutedTask) => Promise<boolean>;
    /** Keep the FIFO head queued until its reply transport has been attached. */
    ready?: (task: RoutedTask) => boolean;
    store: Pick<
      TaskStore,
      "enqueue" | "enqueueDiscord" | "claimNextTask" | "finish"
    > &
      Partial<Pick<TaskStore, "peekNextTask" | "requeueUnaccepted">>;
  },
) {
  let preparedId: string | undefined;
  const queue = createAgentQueue({
    ...config,
    prepare:
      config.prepare &&
      (async () => {
        const task = config.store.peekNextTask?.(config.agentId);
        if (!task || config.ready?.(task) === false) return false;
        preparedId = task.id;
        return config.prepare!(task);
      }),
    requeue: (task) => config.store.requeueUnaccepted?.(task.id) ?? false,
    execute: async (task, report, signal) => {
      const output = await config.execute(task, report, signal);
      if (task.origin.platform === "delegated" && signal.aborted)
        throw new HostTaskError("cancelled");
      return output;
    },
    finalize:
      config.finalize ??
      ((task, status, _signal, outcome) => {
        if (task.origin.platform === "delegated")
          config.store.finish(task.id, status, outcome);
        else config.store.finish(task.id, status);
      }),
    claim: () =>
      config.store.claimNextTask(
        config.agentId,
        (task) =>
          (!config.prepare || task.id === preparedId) &&
          (config.ready?.(task) ?? true),
      ),
    finish: config.store.finish,
    conversation: (task: RoutedTask) => taskOriginKey(task.origin),
  });
  return {
    ...queue,
    submitTelegram(
      botId: number,
      chatId: number,
      prompt: string,
      updateId?: number,
      attachment?: { document?: TelegramDocument; replyDocumentId?: number },
    ) {
      const saved = config.store.enqueue({
        agentId: config.agentId,
        botId,
        chatId,
        prompt,
        telegramDocument: attachment?.document,
        replyDocumentId: attachment?.replyDocumentId,
        ...(updateId === undefined ? {} : { updateId }),
      });
      queue.kick();
      return saved;
    },
    submitDiscord(
      origin: DiscordQueuedTask["origin"],
      prompt: string,
      discordAttachment?: DiscordAttachmentInput,
    ) {
      const saved = config.store.enqueueDiscord({
        agentId: config.agentId,
        origin,
        prompt,
        discordAttachment,
      });
      queue.kick();
      return saved;
    },
    isRunning: (origin: RoutedTask["origin"]) =>
      queue.isRunning(taskOriginKey(origin)),
    stop: (origin: RoutedTask["origin"]) => queue.stop(taskOriginKey(origin)),
  };
}
