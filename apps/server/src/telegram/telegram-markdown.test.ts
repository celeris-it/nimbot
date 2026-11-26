import { describe, expect, it } from "vitest";
import { formatTelegramMarkdown } from "./telegram-markdown.js";

describe("Telegram Markdown", () => {
  it("preserves literal text and protects markup inside code", () => {
    const output = "`**literal**`\n```sh\necho **file**\n```\n**unfinished";
    expect(formatTelegramMarkdown(output, "**Schedule**\n")).toEqual([
      {
        text: "**Schedule**\n**literal**\necho **file**\n**unfinished",
        entities: [
          { type: "code", offset: 13, length: 11 },
          { type: "pre", offset: 25, length: 13, language: "sh" },
        ],
      },
    ]);
  });

  it("keeps formatting on both sides of a split next to an emoji", () => {
    const plain = "x".repeat(4094);
    const parts = formatTelegramMarkdown(`${plain}**A😀B**`);
    expect(parts).toEqual([
      {
        text: `${plain}A`,
        entities: [{ type: "bold", offset: 4094, length: 1 }],
      },
      { text: "😀B", entities: [{ type: "bold", offset: 0, length: 3 }] },
    ]);
  });
});
