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
  const snapshots = new Map<string, Set<string>>();
  function available(task: RoutedTask) {
    const snapshot = snapshots.get(task.id);
    return active(task) && snapshot
      ? selection
          .available(task.agentId)
          .filter(({ descriptor }) => snapshot.has(descriptor.operation))
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
      // Reads may also have an explicit Ask rule. Durable replay prevents a
      // repeated invocation from asking again or executing a second time.
      write: true,
      validate: (args) => selection.validate(config.agentId, operation, args),
      authorize: (current, args, outcome) =>
        authorized(current, args) && (!outcome || rule().decision !== "deny"),
      async execute(current, args, context) {
        const snapshot = JSON.parse(JSON.stringify(args)) as Record<
          string,
          unknown
        >;
        const run = async (signal: AbortSignal, automaticRead = false) => {
          const canRun = () => {
            const policy = rule();
            return (
              authorized(current, snapshot) &&
              policy.decision !== "deny" &&
              (!automaticRead || policy.ruleId === null)
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
            if (outcome.error === "interrupted")
              throw new UncertainExecutionError();
            throw new ToolExecutionError(outcome.error);
          }
          return outcome.result;
        };
        const policy = rule();
        if (selected.tool.access === "read" && policy.ruleId === null) {
          try {
            return await run(context.signal, true);
          } catch (error) {
            if (error instanceof UncertainExecutionError)
              throw new ToolExecutionError("interrupted");
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
    if (!active(task) || !snapshots.has(task.id)) return;
    const resolveCall = (current: RoutedTask, id: string) =>
      snapshots.get(current.id)?.has(id)
        ? resolve(current, id, guard)
        : undefined;
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
          return target.execute(current, input.arguments, context);
        },
      };
  }

  return {
    operations(task: RoutedTask) {
      return active(task) ? [LIST, CALL] : [];
    },
    snapshot(task: RoutedTask) {
      if (!active(task)) return;
      snapshots.set(
        task.id,
        new Set(
          selection
            .available(task.agentId)
            .map(({ descriptor }) => descriptor.operation),
        ),
      );
      return () => snapshots.delete(task.id);
    },
    resolveCatalog,
    descriptors(task: RoutedTask) {
      return active(task) ? selection.descriptors(task.agentId) : [];
    },
    resolve,
  };
}
