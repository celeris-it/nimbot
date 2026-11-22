import type { ChatTask, RoutedTask, TaskStore } from "./tasks/task-queue.js";

/** Resolves an internal child exclusively from Server state, never from its prompt. */
export function createDelegationExecution(config: {
  agentId: string;
  tasks: Pick<TaskStore, "getTask" | "getDelegation">;
  ready(): boolean;
  canReach(parent: ChatTask): boolean;
  allowed(parent: ChatTask, target: string): boolean;
}) {
  function parent(task: RoutedTask): ChatTask | undefined {
    if (
      task.agentId !== config.agentId ||
      task.origin.platform !== "delegated" ||
      !config.ready()
    )
      return undefined;
    const child = config.tasks.getTask(task.id);
    if (
      !child ||
      child.agentId !== config.agentId ||
      child.origin.platform !== "delegated" ||
      !["queued", "running"].includes(child.status) ||
      JSON.stringify(child.origin) !== JSON.stringify(task.origin)
    )
      return undefined;
    const source = config.tasks.getTask(child.origin.parentTaskId);
    const handoff = config.tasks.getDelegation(
      child.origin.sourceAgentId,
      child.origin.delegationId,
    );
    if (
      !source ||
      source.origin.platform === "delegated" ||
      source.status !== "completed" ||
      source.scheduleId !== undefined ||
      source.agentId !== child.origin.sourceAgentId ||
      !handoff ||
      handoff.state !== "admitted" ||
      handoff.cancellationRequested ||
      handoff.sourceTaskId !== source.id ||
      handoff.childTaskId !== child.id ||
      handoff.targetAgentId !== config.agentId ||
      child.prompt !== handoff.brief ||
      !config.canReach(source as ChatTask) ||
      !config.allowed(source as ChatTask, child.agentId)
    )
      return undefined;
    return source as ChatTask;
  }
  return { parent, canExecute: (task: RoutedTask) => !!parent(task) };
}
