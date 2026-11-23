import { CronValidationError } from "../schedules/schedule-time.js";
import { panelErrorMessages } from "./panel-error-messages.js";

const codesByMessage = new Map<string, string>(
  Object.entries(panelErrorMessages).map(
    ([code, message]) => [message, code] as const,
  ),
);

export type PanelErrorCode = keyof typeof panelErrorMessages;

export function panelError(code: PanelErrorCode) {
  return { error: panelErrorMessages[code], code };
}

export function describePanelError(error: string, cause?: unknown) {
  if (cause instanceof CronValidationError) return { error, ...cause.details };
  const code = codesByMessage.get(error);
  return code ? { error, code } : { error };
}
