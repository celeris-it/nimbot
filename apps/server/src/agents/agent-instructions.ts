import type {
  HostApproval,
  HostTaskExecution,
  HostTaskInstructions,
} from "../host/host-tasks.js";

/** Snapshot settings at dispatch so edits cannot change an in-flight task. */
export function withAgentInstructions(
  execute: (
    prompt: string,
    onProgress?: (message: string) => void,
    cancelSignal?: AbortSignal,
    onApproval?: (approval: HostApproval) => void,
    execution?: HostTaskExecution,
    instructions?: HostTaskInstructions,
  ) => Promise<string>,
  getInstructions: () => HostTaskInstructions,
) {
  return (
    prompt: string,
    onProgress?: (message: string) => void,
    cancelSignal?: AbortSignal,
    onApproval?: (approval: HostApproval) => void,
    execution?: HostTaskExecution,
  ) => {
    return execute(
      prompt,
      onProgress,
      cancelSignal,
      onApproval,
      execution,
      getInstructions(),
    );
  };
}
