import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentProcessDirectories } from "../processes/agent-process-config.js";
import type { NotificationResult } from "../notifications/notifications.js";
import type { TaskStatus, TaskStore } from "./task-queue.js";

export type DeliveryOutcome = "delivered" | "not_sent" | "unconfirmed";

export function notificationDelivery(
  result: NotificationResult,
): DeliveryOutcome {
  if (result.status === "delivered") return "delivered";
  return result.status === "failed" && result.sentParts === 0
    ? "not_sent"
    : "unconfirmed";
}

export interface ExecutionEntry {
  id: string;
  status: TaskStatus;
  origin: "telegram" | "discord" | "schedule" | "webhook" | "delegated";
  channel: "telegram" | "discord" | null;
  scheduleName: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  delivery: DeliveryOutcome | "pending" | "unknown" | "not_applicable";
}

export interface ExecutionPage {
  active: ExecutionEntry[];
  history: ExecutionEntry[];
  nextCursor: string | null;
}

type ExecutionResponse = { text: string; partial: boolean };

export interface ExecutionDetail extends ExecutionEntry {
  prompt: string;
  response: ExecutionResponse | null;
  failureReason: string | null;
}

function readHostResponse(
  stateDir: string,
  agentId: string,
  taskId: string,
  hostTaskId: string,
): ExecutionResponse | null {
  let db: DatabaseSync | undefined;
  try {
    const root = realpathSync(stateDir);
    const path = join(
      agentProcessDirectories(root, agentId).tasks,
      "tasks.sqlite",
    );
    if (!lstatSync(path).isFile() || realpathSync(path) !== path) return null;
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA trusted_schema = OFF");
    if (
      db
        .prepare(
          "SELECT type FROM pragma_table_list WHERE schema = 'main' AND name = 'tasks'",
        )
        .get()?.type !== "table"
    )
      return null;
    const row = db
      .prepare(
        `SELECT status, CASE WHEN length(CAST(output AS BLOB)) <= 256000 THEN output END AS output FROM tasks
       WHERE id = ? AND agent_id = ? AND server_task_id = ?
         AND status IN ('completed', 'failed', 'interrupted', 'cancelled')`,
      )
      .get(hostTaskId, agentId, taskId);
    if (
      typeof row?.output !== "string" ||
      (row.status !== "completed" && !row.output)
    )
      return null;
    return {
      text: row.output.slice(0, 64_000),
      partial: row.status !== "completed",
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function createExecutionHistory(store: TaskStore, stateDir: string) {
  return {
    list: store.listExecutions,
    detail(agentId: string, taskId: string): ExecutionDetail | undefined {
      const record = store.getExecution(agentId, taskId);
      if (!record) return undefined;
      const { hostTaskId, responseText, ...detail } = record;
      const response =
        detail.finishedAt === null
          ? null
          : hostTaskId
            ? readHostResponse(stateDir, agentId, taskId, hostTaskId)
            : responseText === null
              ? null
              : { text: responseText, partial: false };
      return { ...detail, response };
    },
  };
}
