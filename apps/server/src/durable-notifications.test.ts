import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openNotificationStore } from "./notification-store.js";
import { createDurableNotifications } from "./durable-notifications.js";
import {
  createNotifications,
  type NotificationResult,
} from "./notifications.js";
import { createLogger } from "./logger.js";

it("persists before sending and deduplicates concurrent requests per agent", async () => {
  const store = openNotificationStore(":memory:");
  try {
    let complete!: (result: NotificationResult) => void;
    const send = vi.fn(() => {
      expect(store.get("a", "request")?.status).toBe("sending");
      return new Promise<NotificationResult>((resolve) => {
        complete = resolve;
      });
    });
    const service = createDurableNotifications(
      store,
      createNotifications({ discord: { send } }),
    );
    const pending = service.send("a", "request", "discord", "private text");
    expect(
      await service.send("a", "request", "discord", "private text"),
    ).toMatchObject({ status: "sending" });
    complete({ status: "delivered", sentParts: 1 });
    await pending;
    expect(
      await service.send("a", "request", "discord", "private text"),
    ).toEqual({ status: "delivered", sentParts: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    await expect(
      service.send("a", "request", "telegram", "private text"),
    ).rejects.toThrow("different content");
    await expect(
      service.send("a", "request", "discord", "changed"),
    ).rejects.toThrow("different content");
    expect(store.begin("b", "request", "discord", "private text").fresh).toBe(
      true,
    );
  } finally {
    store.close();
  }
});

it("keeps failures and uncertain sends across restart without replaying or storing text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notification-store-"));
  const path = join(dir, "state.sqlite");
  let store = openNotificationStore(path);
  try {
    const lines: string[] = [];
    const logger = createLogger((_level, line) => {
      lines.push(line);
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("credential secret"))
      .mockResolvedValueOnce({
        status: "failed",
        sentParts: 0,
        reason: "rejected",
      });
    let service = createDurableNotifications(
      store,
      createNotifications({ discord: { send } }),
      logger,
    );
    await service.send("a", "uncertain", "discord", "private message text");
    await service.send("a", "failed", "discord", "private message text");
    store.begin("a", "crashed", "discord", "private message text");
    store.close();
    store = openNotificationStore(path);
    service = createDurableNotifications(
      store,
      createNotifications({ discord: { send } }),
      logger,
    );
    expect(
      await service.send("a", "uncertain", "discord", "private message text"),
    ).toMatchObject({ status: "uncertain" });
    expect(
      await service.send("a", "failed", "discord", "private message text"),
    ).toMatchObject({ status: "failed" });
    expect(
      await service.send("a", "crashed", "discord", "private message text"),
    ).toMatchObject({ status: "uncertain" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      (await readFile(path)).includes(Buffer.from("private message text")),
    ).toBe(false);
    expect(lines.join("")).not.toMatch(/private message|credential secret/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
