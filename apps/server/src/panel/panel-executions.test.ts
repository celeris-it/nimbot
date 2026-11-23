import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { prepareStateSchema } from "../../../../scripts/state-schema.mjs";
import { agentProcessDirectories } from "../processes/agent-process-config.js";
import { createExecutionHistory } from "../tasks/execution-history.js";
import { openTaskStore } from "../tasks/task-queue.js";
import { hashPassword } from "./panel-auth.js";
import { readPanelConfig } from "./panel-config.js";
import type { ExecutionPage } from "./panel-contracts.js";
import { createPanel } from "./panel.js";

it("serves scoped execution history, including saved responses with the Host stopped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbot-executions-"));
  const serverPath = join(dir, "server.sqlite");
  const tasks = openTaskStore(serverPath);
  const hostPath = join(
    agentProcessDirectories(dir, "a").tasks,
    "tasks.sqlite",
  );
  mkdirSync(dirname(hostPath), { recursive: true });
  prepareStateSchema(hostPath, "tasks");
  const host = new DatabaseSync(hostPath);
  try {
    function enqueue(prompt: string, agentId = "a") {
      return tasks.enqueue({ agentId, botId: 123, chatId: 42, prompt }).id;
    }
    const finish = (id: string) => {
      expect(tasks.claimNextTask("a")?.id).toBe(id);
      tasks.finish(id, "completed");
    };
    for (let i = 0; i < 19; i++) finish(enqueue("old task"));

    for (const [index, hostStatus, response] of [
      [1, "completed", "<strong>saved response</strong>"],
      [2, "completed", ""],
      [3, "failed", "partial response"],
      [4, "failed", ""],
      [5, "completed", "different execution identity"],
      [6, "completed", "no saved Host result"],
    ] as const) {
      const id = enqueue(`prompt ${index}`);
      const hostId = `a0000000-0000-4000-8000-00000000000${index}`;
      expect(tasks.claimNextTask("a")?.id).toBe(id);
      expect(tasks.bindHostTask("a", id, hostId)).toBe(true);
      if (index !== 6)
        host
          .prepare(
            "INSERT INTO tasks (id, agent_id, server_task_id, prompt, status, output) VALUES (?, 'a', ?, 'Host prompt', ?, ?)",
          )
          .run(
            hostId,
            index === 5 ? "different-task" : id,
            hostStatus,
            response,
          );
      tasks.finish(id, hostStatus);

      const detail = createExecutionHistory(tasks, dir).detail("a", id);
      expect(detail).toMatchObject({
        prompt: `prompt ${index}`,
        status: hostStatus,
        delivery: "unknown",
        response:
          index <= 3
            ? { text: response, partial: hostStatus === "failed" }
            : null,
      });
    }

    const config = readPanelConfig({
      PANEL_PASSWORD_HASH: await hashPassword("test-password"),
    });
    const app = createPanel(config, {
      executions: createExecutionHistory(tasks, dir),
      getAgentSetup: (id) =>
        ["a", "b"].includes(id)
          ? { name: id, botUsername: null, provisioning: "ready" }
          : undefined,
    });
    const base = "/api/agents/a/executions";
    expect((await app.request(base)).status).toBe(401);
    const login = await app.request("/api/login", {
      method: "POST",
      headers: {
        Origin: config.origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "password=test-password",
    });
    const headers = { Cookie: login.headers.get("Set-Cookie")!.split(";")[0]! };
    const get = (url: string) => app.request(url, { headers });
    const first = await get(base);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    const page = (await first.json()) as ExecutionPage;
    expect(page.history).toHaveLength(20);
    expect(page.history[0]).not.toHaveProperty("prompt");
    expect(page.history[0]).not.toHaveProperty("response");
    expect(page.nextCursor).toBeTruthy();
    expect((await get(`${base}?before=bad`)).status).toBe(400);
    expect((await get("/api/agents/missing/executions")).status).toBe(404);

    const newest = enqueue("new task");
    finish(newest);
    const other = enqueue("different agent", "b");
    const running = enqueue("running");
    tasks.claimNextTask("a");
    const queued = [enqueue("first in queue"), enqueue("second in queue")];
    const next = (await (
      await get(`${base}?before=${page.nextCursor}`)
    ).json()) as ExecutionPage;
    expect(next.active.map((item) => [item.id, item.status])).toEqual([
      [running, "running"],
      ...queued.map((id) => [id, "queued"]),
    ]);
    expect(next.history).toHaveLength(5);
    expect(
      next.history.some((item) =>
        [...page.history.map(({ id }) => id), newest, other].includes(item.id),
      ),
    ).toBe(false);
    expect(next.nextCursor).toBeNull();
    expect((await get(`${base}/${other}`)).status).toBe(404);
    const detailUrl = `${base}/${page.history[5]!.id}`;
    expect(await (await get(detailUrl)).json()).toMatchObject({
      prompt: "prompt 1",
      response: { text: "<strong>saved response</strong>", partial: false },
    });
    expect((await get(detailUrl.replace("/a/", "/b/"))).status).toBe(404);
  } finally {
    host.close();
    tasks.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("shows schedule, webhook, and delegation sources and recovers unsettled delivery", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbot-execution-delivery-"));
  const path = join(dir, "server.sqlite");
  const tasks = openTaskStore(path);
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      INSERT INTO tasks (id, agent_id, bot_id, chat_id, prompt, status, created_at,
        updated_at, schedule_id, schedule_name, scheduled_for, schedule_trigger)
        VALUES ('scheduled', 'a', 123, 42, 'schedule', 'queued', 1, 1, 's', 'Report', 1, 'schedule');
      INSERT INTO tasks (id, agent_id, platform, discord_bot_id, discord_owner_id,
        discord_channel_id, prompt, status, created_at, updated_at, schedule_id,
        schedule_name, scheduled_for, schedule_trigger)
        VALUES ('webhook', 'a', 'discord', '123', '456', '789', 'hook', 'queued', 2,
          2, 'w', 'Trigger', 2, 'webhook');
    `);
    expect(tasks.listExecutions("a").active).toMatchObject([
      { origin: "schedule", channel: "telegram", scheduleName: "Report" },
      { origin: "webhook", channel: "discord", scheduleName: "Trigger" },
    ]);
    expect(tasks.claimNextTask("a")?.id).toBe("scheduled");
    tasks.finishWithDelegations(
      "scheduled",
      "completed",
      () => false,
      false,
      { ok: true, output: "Finished without a Host" },
      true,
    );
    expect(tasks.getExecution("a", "scheduled")).toMatchObject({
      status: "completed",
      delivery: "pending",
      responseText: "Finished without a Host",
    });
    tasks.markRunningInterrupted();
    tasks.settleExecutionDelivery("scheduled", "delivered");
    expect(tasks.getExecution("a", "scheduled")).toMatchObject({
      status: "completed",
      delivery: "unconfirmed",
    });

    expect(tasks.claimNextTask("a")?.id).toBe("webhook");
    tasks.finishWithDelegations(
      "webhook",
      "failed",
      () => false,
      false,
      { ok: false, kind: "timeout" },
      true,
    );
    tasks.settleExecutionDelivery("webhook", "delivered");
    expect(tasks.getExecution("a", "webhook")).toMatchObject({
      status: "failed",
      delivery: "delivered",
      failureReason: "timeout",
    });

    const parent = tasks.enqueue({
      agentId: "source",
      botId: 123,
      chatId: 42,
      prompt: "parent",
    });
    tasks.claimNextTask("source");
    tasks.stageDelegation(
      {
        parentTaskId: parent.id,
        targetAgentId: "a",
        invocationId: randomUUID(),
        brief: "child",
      },
      () => true,
    );
    tasks.finishWithDelegations(parent.id, "completed", () => true);
    expect(tasks.listExecutions("a").active).toMatchObject([
      { origin: "delegated", channel: null, delivery: "not_applicable" },
    ]);
  } finally {
    db.close();
    tasks.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
