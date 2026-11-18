import type { BridgeTool } from "./tool-bridge.js";

/** Only Host-registered definitions can select a Server operation. Arguments carry no endpoint or credential. */
export function createServerTool(
  definition: Omit<BridgeTool, "invoke">,
): BridgeTool {
  const operation = definition.operation;
  return {
    ...definition,
    async invoke(args, { context, invocationId, signal }) {
      if (!context.requestTool) throw new Error("Tool transport unavailable");
      return context.requestTool(operation, args, invocationId, signal);
    },
  };
}
