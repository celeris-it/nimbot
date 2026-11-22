import { describe, expect, it } from "vitest";
import { splitTelegramText } from "./telegram-text.js";

describe("Telegram text splitting", () => {
  it.each([
    "",
    "short",
    "x".repeat(4096),
    "x".repeat(64000),
    "x".repeat(4095) + "😀".repeat(5000),
  ])("preserves text and fits message limits (%#)", (text) => {
    const parts = splitTelegramText(text);
    expect(parts.join("")).toBe(text);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4096);
      expect(part.length).toBeGreaterThan(0);
      expect(part).not.toMatch(/[\uD800-\uDFFF]/u);
    }
  });
});
