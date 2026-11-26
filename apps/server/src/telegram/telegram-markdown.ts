import type { Api } from "grammy";
import { splitTelegramText } from "./telegram-text.js";

type Entity = NonNullable<
  NonNullable<Parameters<Api["sendMessage"]>[2]>["entities"]
>[number];

// Recognize common reply formatting. Match code and escapes before inline markup.
const markup = new RegExp(
  [
    /^ {0,3}```(?<language>[\w+-]*)[^\S\n]*\n(?<block>[\s\S]*?)(?:^ {0,3}```[^\S\n]*$|(?![\s\S]))/,
    /(?<escaped>\\[\\`*[\]])/,
    /`(?<code>[^`\n]+)`/,
    /\*\*(?<bold>[^*\n]+)\*\*/,
    /\[(?<label>[^\][\n]+)\]\((?<url>https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/,
  ]
    .map((pattern) => pattern.source)
    .join("|"),
  "gm",
);

export function formatTelegramMarkdown(markdown: string, prefix = "") {
  let text = prefix;
  let cursor = 0;
  const entities: Entity[] = [];
  for (const match of markdown.matchAll(markup)) {
    const { escaped, language, code, bold, label, url } = match.groups!;
    const block = match.groups!.block?.replace(/\r?\n$/, "");
    text += markdown.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const offset = text.length;
    if (block?.trim()) {
      text += block;
      entities.push({ type: "pre", offset, length: block.length, language });
    } else if (code?.trim()) {
      text += code;
      entities.push({ type: "code", offset, length: code.length });
    } else if (bold?.trim()) {
      text += bold;
      entities.push({ type: "bold", offset, length: bold.length });
    } else if (label?.trim() && url && URL.canParse(url)) {
      text += label;
      entities.push({ type: "text_link", offset, length: label.length, url });
    } else {
      text += escaped?.slice(1) ?? match[0];
    }
  }
  text += markdown.slice(cursor);

  let start = 0;
  let firstEntity = 0;
  return splitTelegramText(text).map((part) => {
    const end = start + part.length;
    const partEntities: Entity[] = [];
    while (firstEntity < entities.length) {
      const entity = entities[firstEntity]!;
      if (entity.offset >= end) break;
      const entityStart = Math.max(start, entity.offset);
      const entityEnd = entity.offset + entity.length;
      partEntities.push({
        ...entity,
        offset: entityStart - start,
        length: Math.min(end, entityEnd) - entityStart,
      });
      if (entityEnd > end) break;
      firstEntity++;
    }
    start = end;
    return { text: part, entities: partEntities };
  });
}
