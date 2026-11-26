import { randomUUID } from "node:crypto";
import {
  UncertainExecutionError,
  type ApprovalGate,
} from "../approvals/approval-gate.js";
import type { ApprovalRules } from "../approvals/approval-rules.js";
import type { McpCatalog } from "./mcp-catalog.js";
import type { createMcpExecution } from "./mcp-execution.js";
import { z } from "zod";
import { createMcpToolSelection } from "./mcp-tool-selection.js";
import type { RoutedTask, TaskStore } from "../tasks/task-queue.js";
import {
  ToolExecutionError,
  type ServerToolHandler,
} from "../tasks/tool-dispatch.js";

/** Trusted policy identifiers are independent of remote hints and model-visible names. */
export const mcpActionType = (access: "read" | "write") => `mcp.${access}`;
export const mcpTarget = (definitionId: string, toolName: string) =>
  `${definitionId}:${toolName}`;

const LIST = "catalog-mcp.list";
const CALL = "catalog-mcp.call";
const READ_RESULT = "catalog-mcp.read-result";
const INLINE_RESULT_BYTES = 12_000;
const MAX_SAVED_RESULT_BYTES = 256 * 1024;
const MAX_TASK_RESULT_BYTES = 2 * 1024 * 1024;
const toolId = z.string().regex(/^mcp\.[a-f0-9]{64}$/);
const cursor = z.int().min(0).optional();
const listArgs = z.union([
  z.strictObject({ query: z.string().max(128).optional(), cursor }),
  z.strictObject({ toolId, cursor }),
]);
const callArgs = z.strictObject({
  toolId,
  arguments: z.record(z.string(), z.unknown()),
});
const readResultArgs = z.strictObject({
  resultId: z.uuid(),
  cursor: z.int().min(1),
});

function resultPage(resultId: string, json: string, offset: number) {
  let end = offset;
  let high = Math.min(json.length, offset + INLINE_RESULT_BYTES);
  // Reserve room for page metadata and measure the escaped JSON string.
  while (end < high) {
    const middle = Math.ceil((end + high) / 2);
    const bytes = Buffer.byteLength(JSON.stringify(json.slice(offset, middle)));
    if (bytes <= INLINE_RESULT_BYTES - 128) end = middle;
    else high = middle - 1;
  }
  if (/[\uD800-\uDBFF]/.test(json.charAt(end - 1))) end--;
  return {
    resultId,
    resultJson: json.slice(offset, end),
    ...(end < json.length ? { nextCursor: end } : {}),
  };
}

/** Server-owned bridge between pinned catalog grants, approvals and remote execution. */
export function createMcpTools(config: {
  agentId: string;
  catalog: McpCatalog;
  tasks: Pick<TaskStore, "getTask">;
  rules: Pick<ApprovalRules, "evaluate">;
  canReach(task: RoutedTask): boolean;
  execute: ReturnType<typeof createMcpExecution>;
}) {
  const selection = createMcpToolSelection(config.catalog);
  const active = (task: RoutedTask) => {
    const saved = config.tasks.getTask(task.id);
    return (
      task.agentId === config.agentId &&
      task.origin.platform !== "delegated" &&
      task.scheduleId === undefined &&
      saved?.status === "running" &&
      saved.agentId === task.agentId &&
      saved.scheduleId === undefined &&
      JSON.stringify(saved.origin) === JSON.stringify(task.origin) &&
      config.canReach(saved)
    );
  };
  const snapshots = new Map<
    string,
    {
      operations: Set<string>;
      results: Map<string, { operation: string; json: string }>;
      resultBytes: number;
    }
  >();
  function available(task: RoutedTask) {
    const snapshot = snapshots.get(task.id);
    return active(task) && snapshot
      ? selection
          .available(task.agentId)
          .filter(({ descriptor }) =>
            snapshot.operations.has(descriptor.operation),
          )
      : [];
  }
  function resolve(
    task: RoutedTask,
    operation: string,
    guard: ApprovalGate["guard"],
  ): ServerToolHandler | undefined {
    if (!active(task)) return undefined;
    const selected = selection.resolve(task.agentId, operation);
    if (!selected) return undefined;
    const actionType = mcpActionType(selected.tool.access);
    const target = mcpTarget(selected.definitionId, selected.tool.name);
    const rule = () =>
      config.rules.evaluate(config.agentId, actionType, target);
    const authorized = (current: RoutedTask, args: unknown) =>
      active(current) && !!selection.validate(current.agentId, operation, args);
    return {
      operation,
      // Record invocations durably so replay cannot execute a tool twice.
      write: true,
      validate: (args) => selection.validate(config.agentId, operation, args),
      authorize: (current, args, outcome) =>
        authorized(current, args) && (!outcome || rule().decision !== "deny"),
      async execute(current, args, context) {
        const snapshot = JSON.parse(JSON.stringify(args)) as Record<
          string,
          unknown
        >;
        let responseTooLarge = false;
        const run = async (signal: AbortSignal, automatic = false) => {
          const canRun = () => {
            const policy = rule();
            return (
              authorized(current, snapshot) &&
              policy.decision !== "deny" &&
              (!automatic || policy.ruleId === null)
            );
          };
          signal.throwIfAborted();
          if (!canRun()) throw new ToolExecutionError("denied");
          const outcome = await config.execute(
            config.agentId,
            operation,
            snapshot,
            {
              signal,
              allowed: canRun,
            },
          );
          if (!outcome.ok) {
            responseTooLarge = outcome.error === "response_too_large";
            if (
              outcome.error === "interrupted" ||
              (responseTooLarge && selected.tool.access === "write")
            )
              throw new UncertainExecutionError();
            throw new ToolExecutionError(outcome.error);
          }
          return outcome.result;
        };
        const policy = rule();
        if (policy.ruleId === null) {
          try {
            return await run(context.signal, true);
          } catch (error) {
            if (error instanceof UncertainExecutionError)
              throw new ToolExecutionError(
                responseTooLarge ? "response_too_large" : "interrupted",
              );
            throw error;
          }
        }
        const decision = await guard(
          current,
          {
            actionType,
            target,
            summary: `Run external MCP ${selected.tool.access}: ${selected.tool.name}`,
            arguments: { operation, argumentsJson: JSON.stringify(snapshot) },
            ttlMs: 30_000,
          },
          run,
          context.signal,
        );
        if (responseTooLarge)
          throw new ToolExecutionError("response_too_large");
        if (decision.status === "uncertain")
          throw new ToolExecutionError("interrupted");
        if (decision.status === "denied")
          throw new ToolExecutionError("denied");
        if (decision.status !== "executed")
          throw new ToolExecutionError("failed");
        return decision.result;
      },
    };
  }

  function resolveCatalog(
    task: RoutedTask,
    operation: string,
    guard: ApprovalGate["guard"],
  ): ServerToolHandler | undefined {
    const snapshot = snapshots.get(task.id);
    if (!active(task) || !snapshot) return;
    const resolveCall = (current: RoutedTask, id: string) =>
      snapshots.get(current.id)?.operations.has(id)
        ? resolve(current, id, guard)
        : undefined;
    if (operation === READ_RESULT) {
      const find = (current: RoutedTask, resultId: string) => {
        if (!active(current) || snapshots.get(current.id) !== snapshot) return;
        const result = snapshot.results.get(resultId);
        if (!result) return;
        const selected = selection.resolve(current.agentId, result.operation);
        if (
          selected &&
          config.rules.evaluate(
            current.agentId,
            mcpActionType(selected.tool.access),
            mcpTarget(selected.definitionId, selected.tool.name),
          ).decision !== "deny"
        )
          return result;
      };
      return {
        operation,
        write: false,
        validate: (args) => readResultArgs.safeParse(args).data,
        authorize: (current, args) =>
          !!find(current, readResultArgs.parse(args).resultId),
        async execute(current, args) {
          const { resultId, cursor } = readResultArgs.parse(args);
          const result = find(current, resultId);
          if (!result) throw new ToolExecutionError("denied");
          if (
            cursor >= result.json.length ||
            /[\uDC00-\uDFFF]/.test(result.json.charAt(cursor))
          )
            throw new ToolExecutionError("failed");
          return resultPage(resultId, result.json, cursor);
        },
      };
    }
    if (operation === LIST)
      return {
        operation,
        write: false,
        validate(args) {
          return listArgs.safeParse(args).data;
        },
        async execute(current, args) {
          const input = listArgs.parse(args);
          const tools = available(current);
          if ("toolId" in input) {
            const entry = tools.find(
              ({ descriptor }) => descriptor.operation === input.toolId,
            );
            if (!entry) throw new ToolExecutionError("denied");
            const schema = entry.tool.inputSchema;
            const encoded = JSON.stringify(schema);
            if (
              input.cursor === undefined &&
              Buffer.byteLength(encoded) <= 12_000
            )
              return { inputSchema: schema };
            const offset = input.cursor ?? 0;
            if (offset > encoded.length) throw new ToolExecutionError("failed");
            const limit = Math.min(encoded.length, offset + 1500);
            const end = /[\uD800-\uDBFF]/.test(encoded.charAt(limit - 1))
              ? limit - 1
              : limit;
            return {
              schemaJson: encoded.slice(offset, end),
              ...(end < encoded.length ? { nextCursor: end } : {}),
            };
          }
          const query = input.query?.trim().toLowerCase() ?? "";
          const matches = tools.filter(({ label, tool }) =>
            `${label} ${tool.name}`.toLowerCase().includes(query),
          );
          const offset = input.cursor ?? 0;
          const page = matches.slice(offset, offset + 12);
          return {
            tools: page.map(({ descriptor, label, tool }) => ({
              id: descriptor.operation,
              integration: label,
              name: tool.name,
              access: tool.access,
            })),
            ...(offset + page.length < matches.length
              ? { nextCursor: offset + page.length }
              : {}),
          };
        },
      };
    if (operation === CALL)
      return {
        operation,
        write: true,
        validate(args) {
          const input = callArgs.safeParse(args).data;
          if (
            input &&
            resolveCall(task, input.toolId)?.validate(input.arguments)
          )
            return input;
        },
        authorize(current, args, outcome) {
          const input = callArgs.parse(args);
          return (
            resolveCall(current, input.toolId)?.authorize?.(
              current,
              input.arguments,
              outcome,
            ) === true
          );
        },
        async execute(current, args, context) {
          const input = callArgs.parse(args);
          const target = resolveCall(current, input.toolId);
          if (!target) throw new ToolExecutionError("denied");
          const result = await target.execute(
            current,
            input.arguments,
            context,
          );
          const json = JSON.stringify(result);
          const bytes = Buffer.byteLength(json);
          if (bytes <= INLINE_RESULT_BYTES) return result;
          context.signal.throwIfAborted();
          if (snapshots.get(current.id) !== snapshot)
            throw new ToolExecutionError("denied");
          if (bytes > MAX_SAVED_RESULT_BYTES)
            throw new ToolExecutionError("response_too_large");
          if (snapshot.resultBytes + bytes > MAX_TASK_RESULT_BYTES)
            throw new ToolExecutionError("result_storage_full");
          const resultId = randomUUID();
          snapshot.results.set(resultId, { operation: input.toolId, json });
          snapshot.resultBytes += bytes;
          return resultPage(resultId, json, 0);
        },
      };
  }

  return {
    operations(task: RoutedTask) {
      return active(task) ? [LIST, CALL, READ_RESULT] : [];
    },
    snapshot(task: RoutedTask) {
      if (!active(task)) return;
      snapshots.set(task.id, {
        operations: new Set(
          selection
            .available(task.agentId)
            .map(({ descriptor }) => descriptor.operation),
        ),
        results: new Map(),
        resultBytes: 0,
      });
      return () => snapshots.delete(task.id);
    },
    resolveCatalog,
    descriptors(task: RoutedTask) {
      return active(task) ? selection.descriptors(task.agentId) : [];
    },
    resolve,
  };
}
