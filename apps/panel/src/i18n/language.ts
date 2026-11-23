import { derived, writable } from "svelte/store";
import { spanish } from "./es.js";

export type Language = "en" | "es";
export type LanguagePreference = Language | "browser";
export type MessageKey = keyof typeof spanish;

function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(spanish, value);
}
type MessageValue = string | number;

type ParametersFor<
  Key extends string,
  Values extends MessageValue[] = [],
> = Key extends `${string}{${Values["length"]}}${infer Tail}`
  ? ParametersFor<Tail, [...Values, MessageValue]>
  : Values;

export interface Translate {
  readonly language: Language;
  <Key extends MessageKey>(key: Key, ...values: ParametersFor<Key>): string;
}

export function translator(language: Language): Translate {
  const translate = <Key extends MessageKey>(
    key: Key,
    ...values: ParametersFor<Key>
  ) =>
    (language === "es" ? spanish[key] : key).replace(
      /\{(\d+)\}/g,
      (_, index: string) => String(values[Number(index)] ?? ""),
    );
  return Object.assign(translate, { language });
}

export function translateDescription(t: Translate, description: string) {
  if (!isMessageKey(description) || /\{\d+\}/.test(description))
    return description;
  // The placeholder check narrows the runtime string to non-parameterized messages.
  return t(description as StaticMessageKey);
}

type StaticMessageKey = {
  [Key in MessageKey]: ParametersFor<Key> extends [] ? Key : never;
}[MessageKey];

const storageKey = "nimbot-panel-language";
export const languagePreference = writable<LanguagePreference>("browser");
const language = writable<Language>("en");
export const messages = derived(language, translator);
export const formattingLocale = derived(language, (value) =>
  value === "es" ? "es-419" : "en-US",
);

export const numberFormat = derived(
  formattingLocale,
  (locale) => new Intl.NumberFormat(locale),
);
export const pluralRules = derived(
  formattingLocale,
  (locale) => new Intl.PluralRules(locale),
);

export function isLanguagePreference(
  value: unknown,
): value is LanguagePreference {
  return value === "en" || value === "es" || value === "browser";
}

export function browserLanguage(preferences: readonly string[]): Language {
  for (const tag of preferences) {
    const primary = tag.toLowerCase().split("-")[0];
    if (primary === "es" || primary === "en") return primary;
  }
  return "en";
}

function applyLanguage(preference: LanguagePreference) {
  const selected =
    preference === "browser"
      ? browserLanguage(
          navigator.languages.length
            ? navigator.languages
            : [navigator.language],
        )
      : preference;
  document.documentElement.lang = selected;
  language.set(selected);
  languagePreference.set(preference);
}

export function initializeLanguage() {
  let preference: LanguagePreference = "browser";
  try {
    const saved = localStorage.getItem(storageKey);
    if (isLanguagePreference(saved)) preference = saved;
  } catch {
    // Browser language is available even when storage is blocked.
  }
  applyLanguage(preference);
}

export function saveLanguage(preference: LanguagePreference) {
  applyLanguage(preference);
  try {
    localStorage.setItem(storageKey, preference);
  } catch {
    // The chosen language still applies for this visit.
  }
}
