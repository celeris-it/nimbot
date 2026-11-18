/** Host-dispatched operations the Server may grant to a task; the Host registers the handlers. */
export const MEMORY_OPERATIONS: readonly string[] = [
  "memory.create",
  "memory.search",
  "memory.update",
  "memory.delete",
];

/** Grants only for this agent's own tasks, and only while the administrator has memory on. */
export function memoryToolPolicy(
  agentId: string,
  enabled: () => boolean,
): {
  canExecute(task: { agentId: string }): boolean;
  allowedOperations(task: { agentId: string }): readonly string[];
} {
  return {
    canExecute: (task) => task.agentId === agentId && enabled(),
    allowedOperations: () => MEMORY_OPERATIONS,
  };
}
