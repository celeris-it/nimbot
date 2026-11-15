import type { HostApproval } from "./host-tasks.js";

/** Snapshot settings at submission so edits cannot change an in-flight task. */
export function withAgentInstructions(
  execute: (
    prompt: string,
    onProgress?: (message: string) => void,
    cancelSignal?: AbortSignal,
    onApproval?: (approval: HostApproval) => void,
  ) => Promise<string>,
  getInstructions: () => string,
) {
  return (
    prompt: string,
    onProgress?: (message: string) => void,
    cancelSignal?: AbortSignal,
    onApproval?: (approval: HostApproval) => void,
  ) => {
    const instructions = getInstructions();
    return execute(
      instructions
        ? `Agent instructions:\n${instructions}\n\nUser task:\n${prompt}`
        : prompt,
      onProgress,
      cancelSignal,
      onApproval,
    );
  };
}
