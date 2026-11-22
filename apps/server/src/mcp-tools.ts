import {
  UncertainExecutionError,
  type ApprovalGate,
} from "./approvals/approval-gate.js";
import type { ApprovalRules } from "./approvals/approval-rules.js";
import type { McpCatalog } from "./mcp-catalog.js";
import type { createMcpExecution } from "./mcp-execution.js";
import { createMcpToolSelection } from "./mcp-tool-selection.js";
import type { RoutedTask, TaskStore } from "./tasks/task-queue.js";
import {
  ToolExecutionError,
  type ServerToolHandler,
} from "./tasks/tool-dispatch.js";

/** Trusted policy identifiers are independent of remote hints and model-visible names. */
export const mcpActionType = (access: "read" | "write") => `mcp.${access}`;
export const mcpTarget = (definitionId: string, toolName: string) =>
  `${definitionId}:${toolName}`;

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
  return {
    descriptors(task: RoutedTask) {
      return active(task) ? selection.descriptors(task.agentId) : [];
    },
    resolve(
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
        active(current) &&
        !!selection.validate(current.agentId, operation, args);
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
    },
  };
}
