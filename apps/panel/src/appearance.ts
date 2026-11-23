export type Appearance = "system" | "light" | "dark";

const appearanceKey = "nimbot-panel-appearance";
export const systemAppearance = window.matchMedia(
  "(prefers-color-scheme: dark)",
);

export function isAppearance(value: string | null): value is Appearance {
  return value === "system" || value === "light" || value === "dark";
}

export function readAppearance(): Appearance {
  try {
    const value = localStorage.getItem(appearanceKey);
    if (isAppearance(value)) return value;
  } catch {
    // The system preference is available when browser storage is blocked.
  }
  return "system";
}

export function applyAppearance(preference: Appearance) {
  document.documentElement.dataset.theme =
    preference === "system"
      ? systemAppearance.matches
        ? "dark"
        : "light"
      : preference;
}

export function saveAppearance(preference: Appearance) {
  applyAppearance(preference);
  try {
    localStorage.setItem(appearanceKey, preference);
  } catch {
    // The selected appearance still applies for this visit.
  }
}
