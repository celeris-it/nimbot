import { panelErrorMessages } from "../../../server/src/panel/panel-error-messages.js";
import {
  CronValidationError,
  type CronErrorDetails,
} from "../../../server/src/schedules/schedule-time.js";
import type { Translate } from "./language.js";

type PanelErrorCode = keyof typeof panelErrorMessages;
const errorKeys = new Set<string>(Object.values(panelErrorMessages));

function isPanelErrorKey(
  value: string,
): value is (typeof panelErrorMessages)[PanelErrorCode] {
  return errorKeys.has(value);
}

const cronFields = {
  minute: "minute",
  hour: "hour",
  "day of month": "day of month",
  month: "month",
  "day of week": "day of week",
} as const;

function translateCronDetails(
  t: Translate,
  code: string,
  params: readonly unknown[],
): string | undefined {
  const [field, value, min, max] = params;
  if (code === "cron_too_long" && typeof field === "number")
    return t("Cron expression must be at most {0} characters.", field);
  if (typeof field !== "string" || !Object.hasOwn(cronFields, field)) return;
  const label = t(cronFields[field as keyof typeof cronFields]);
  switch (code) {
    case "cron_invalid_value":
      if (typeof value === "string")
        return t('Cron {0} field: Invalid value "{1}".', label, value);
      break;
    case "cron_invalid_item":
      if (typeof value === "string")
        return t('Cron {0} field: Invalid item "{1}".', label, value);
      break;
    case "cron_value_outside_range":
      if (
        typeof value === "string" &&
        typeof min === "number" &&
        typeof max === "number"
      )
        return t(
          "Cron {0} field: {1} is outside {2}-{3}.",
          label,
          value,
          min,
          max,
        );
      break;
    case "cron_step_requires_range":
      return t("Cron {0} field: Steps require a range or *.", label);
    case "cron_invalid_step":
      return t("Cron {0} field: Step must be a positive whole number.", label);
    case "cron_reversed_range":
      return t("Cron {0} field: Range must start at or before its end.", label);
  }
}

export function translateApiError(
  t: Translate,
  code: string | undefined,
  params: unknown,
  english: string,
) {
  if (code && Object.hasOwn(panelErrorMessages, code))
    return t(panelErrorMessages[code as PanelErrorCode]);
  if (code && Array.isArray(params)) {
    const cron = translateCronDetails(t, code, params);
    if (cron) return cron;
  }
  // An older response may only carry the English text.
  if (!code) {
    if (isPanelErrorKey(english)) return t(english);
    if (t.language === "en") return english;
  }
  const fallback =
    "The request could not be completed. Refresh the status before retrying.";
  return t(fallback);
}

export function translateScheduleError(t: Translate, error: unknown) {
  if (error instanceof CronValidationError) {
    const details: CronErrorDetails = error.details;
    return (
      translateCronDetails(t, details.code, details.params) ?? error.message
    );
  }
  if (error instanceof Error && isPanelErrorKey(error.message))
    return t(error.message);
  return t("Invalid cadence.");
}
