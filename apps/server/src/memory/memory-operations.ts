import type { RoutedTask } from "../tasks/task-queue.js";

/** Host-dispatched operations the Server may grant to a task; the Host registers the handlers. */
const MEMORY_OPERATIONS: readonly string[] = [
  "memory.create",
  "memory.search",
  "memory.update",
  "memory.delete",
];

export function memoryOperationsForTask(task: RoutedTask): readonly string[] {
  return task.scheduleId === undefined && task.origin.platform !== "delegated"
    ? MEMORY_OPERATIONS
    : [];
}
