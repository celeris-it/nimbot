import { expect, it } from "vitest";
import { createApprovalBook } from "./approvals.js";

const entry = {
  botId: 1,
  chatId: 10,
  hostTaskId: "task",
  approvalId: "a".repeat(36),
};

it("issues random single-use keys bound to one bot and chat", () => {
  const book = createApprovalBook();
  const key = book.add(entry);
  expect(key).toMatch(/^[A-Za-z0-9_-]{12}$/);
  expect(book.add(entry)).not.toBe(key);
  expect(book.take(key, { botId: 2, chatId: 10 })).toBeUndefined();
  expect(book.take(key, { botId: 1, chatId: 11 })).toBeUndefined();
  expect(book.take("unknown-key", { botId: 1, chatId: 10 })).toBeUndefined();
  expect(book.take(key, { botId: 1, chatId: 10 })).toMatchObject(entry);
  expect(book.take(key, { botId: 1, chatId: 10 })).toBeUndefined();
});

it("expires keys", () => {
  let clock = 0;
  const book = createApprovalBook(1000, () => clock);
  const key = book.add(entry);
  clock = 1001;
  expect(book.take(key, { botId: 1, chatId: 10 })).toBeUndefined();
});
