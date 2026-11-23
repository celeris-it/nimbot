import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { panelErrorMessages } from "../../../server/src/panel/panel-error-messages.js";
import { parseCronExpression } from "../../../server/src/schedules/schedule-time.js";
import { spanish } from "./es.js";
import { translateApiError, translateScheduleError } from "./errors.js";
import {
  browserLanguage,
  formattingLocale,
  initializeLanguage,
  languagePreference,
  saveLanguage,
  translator,
} from "./language.js";

function setupBrowser(preferences: string[], saved?: string) {
  const document = { documentElement: { lang: "" } };
  const storage = new Map(saved ? [["nimbot-panel-language", saved]] : []);
  vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", { languages: preferences });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  return document.documentElement;
}

afterEach(() => vi.unstubAllGlobals());

describe("panel languages", () => {
  it("uses the first supported browser language and handles regional tags", () => {
    expect(browserLanguage(["fr-FR", "es-AR", "en"])).toBe("es");
    expect(browserLanguage(["en-GB", "es-MX"])).toBe("en");
    expect(browserLanguage(["ja", "fr"])).toBe("en");
    expect(browserLanguage([])).toBe("en");
  });

  it("remembers an override and can restore browser detection", () => {
    const html = setupBrowser(["es-AR"], "invalid");
    initializeLanguage();
    expect(html.lang).toBe("es");
    expect(get(formattingLocale)).toBe("es-419");
    saveLanguage("en");
    initializeLanguage();
    expect(html.lang).toBe("en");
    expect(get(languagePreference)).toBe("en");
    expect(get(formattingLocale)).toBe("en-US");
    saveLanguage("browser");
    expect(html.lang).toBe("es");
  });

  it("applies changes when browser storage is blocked", () => {
    const html = setupBrowser(["es-MX"]);
    const blocked = () => {
      throw new Error("Storage blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    initializeLanguage();
    expect(html.lang).toBe("es");
    saveLanguage("en");
    expect(html.lang).toBe("en");
    expect(get(languagePreference)).toBe("en");
  });
});

describe("panel messages", () => {
  it("covers API keys and preserves interpolation parameters in both languages", () => {
    const placeholders = (text: string) => text.match(/\{\d+\}/g)?.sort() ?? [];
    for (const [english, translation] of Object.entries(spanish)) {
      expect(translation, english).not.toBe("");
      expect(placeholders(translation), english).toEqual(placeholders(english));
    }
    for (const english of Object.values(panelErrorMessages))
      expect(spanish).toHaveProperty([english]);

    expect(translator("es")("Switch agent, {0}", "Mistral")).toBe(
      "Cambiar de agente, Mistral",
    );
  });

  it("translates known API errors and has a fallback for unknown codes", () => {
    const t = translator("es");
    expect(
      translateApiError(t, "incorrect_password", undefined, "English"),
    ).toBe("Contraseña incorrecta. Vuelve a intentarlo.");
    expect(translateApiError(t, "future_code", undefined, "English")).toContain(
      "No se pudo completar la solicitud.",
    );
  });

  it("uses the same localized cron error for form and API validation", () => {
    const t = translator("es");
    const expected = "Campo hora de cron: 24 está fuera del rango 0-23.";
    expect(
      translateApiError(
        t,
        "cron_value_outside_range",
        ["hour", "24", 0, 23],
        "",
      ),
    ).toBe(expected);
    expect(() => parseCronExpression("0 24 * * *")).toThrowError(
      "Cron hour field: 24 is outside 0-23.",
    );
    try {
      parseCronExpression("0 24 * * *");
    } catch (error) {
      expect(translateScheduleError(t, error)).toBe(expected);
    }
  });
});
