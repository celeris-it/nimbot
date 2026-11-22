/** Stay within Telegram's 4096-character limit without breaking surrogate pairs. */
export function splitTelegramText(text: string): string[] {
  const parts: string[] = [];
  let part = "";
  for (const character of text) {
    if (part.length + character.length > 4096) {
      parts.push(part);
      part = "";
    }
    part += character;
  }
  if (part) parts.push(part);
  return parts;
}
