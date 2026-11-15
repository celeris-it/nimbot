/** Snapshot settings at submission so edits cannot change an in-flight task. */
export function withAgentInstructions(
  execute: (
    prompt: string,
    onProgress?: (message: string) => void,
    cancelSignal?: AbortSignal,
  ) => Promise<string>,
  getInstructions: () => string,
) {
  return (
    prompt: string,
    onProgress?: (message: string) => void,
    cancelSignal?: AbortSignal,
  ) => {
    const instructions = getInstructions();
    return execute(
      instructions
        ? `Agent instructions:\n${instructions}\n\nUser task:\n${prompt}`
        : prompt,
      onProgress,
      cancelSignal,
    );
  };
}
