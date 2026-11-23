import type { Translate } from "./language.js";

function formField(target: EventTarget | null) {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  )
    return target;
}

export function localizeInvalidField(event: Event, t: Translate) {
  const field = formField(event.target);
  if (!field) return;
  const { validity } = field;
  if (validity.valueMissing) field.setCustomValidity(t("Fill out this field."));
  else if (
    validity.typeMismatch &&
    field instanceof HTMLInputElement &&
    field.type === "url"
  )
    field.setCustomValidity(t("Enter a valid URL."));
  else if (
    validity.badInput ||
    validity.patternMismatch ||
    validity.tooLong ||
    validity.tooShort ||
    validity.rangeUnderflow ||
    validity.rangeOverflow ||
    validity.stepMismatch ||
    validity.typeMismatch
  )
    field.setCustomValidity(t("Check the value entered in this field."));
}

export function clearFieldValidation(event: Event) {
  formField(event.target)?.setCustomValidity("");
}
