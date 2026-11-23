import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { AcpClient, type SessionUpdate } from "./acp-client.js";

type Rpc = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};

/** Fake agent: answers the client's requests with scripted behaviour. */
function fakeAgent(handler: (msg: Rpc, send: (m: unknown) => void) => void) {
  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  const send = (m: unknown) =>
    toClient.write(JSON.stringify({ jsonrpc: "2.0", ...(m as object) }) + "\n");
  createInterface({ input: toAgent }).on("line", (line) =>
    handler(JSON.parse(line) as Rpc, send),
  );
  return { input: toClient, output: toAgent };
}

describe("AcpClient", () => {
  it("selects reasoning effort and resets a restored selection to default", async () => {
    const settings: unknown[] = [];
    let effort = "low";
    let echoed = false;
    const { input, output } = fakeAgent((msg, send) => {
      settings.push(msg.params);
      if (msg.params?.configId === "effort" && msg.params.value !== "invalid")
        effort = String(msg.params.value);
      const stale = effort === "high" && !echoed;
      echoed ||= stale;
      send({
        id: msg.id,
        result: {
          configOptions: [
            { id: "model", currentValue: "fixture/vendor/model" },
            { id: "effort", currentValue: stale ? "low" : effort },
          ],
        },
      });
    });
    const client = new AcpClient(input, output);
    await client.setModel("s1", "fixture", "vendor/model", "high");
    await client.setModel("s1", "fixture", "vendor/model");
    expect(settings).toEqual([
      { sessionId: "s1", configId: "model", value: "fixture/vendor/model" },
      { sessionId: "s1", configId: "effort", value: "high" },
      { sessionId: "s1", configId: "effort", value: "high" },
      { sessionId: "s1", configId: "model", value: "fixture/vendor/model" },
      { sessionId: "s1", configId: "effort", value: "default" },
    ]);
    await expect(
      client.setModel("s1", "fixture", "vendor/model", "invalid"),
    ).rejects.toThrow("could not select the configured reasoning effort");
  });

  it("registers HTTP MCP on both new and loaded sessions when supported", async () => {
    const seen: Rpc[] = [];
    const { input, output } = fakeAgent((msg, send) => {
      seen.push(msg);
      send({
        id: msg.id,
        result:
          msg.method === "initialize"
            ? {
                agentCapabilities: {
                  loadSession: true,
                  mcpCapabilities: { http: true },
                },
              }
            : { sessionId: "s1" },
      });
    });
    const client = new AcpClient(input, output);
    const servers = [
      {
        type: "http" as const,
        name: "nimbot",
        url: "http://127.0.0.1:1234/mcp",
        headers: [{ name: "Authorization", value: "Bearer per-turn" }],
      },
    ];
    await client.initialize();
    await client.newSession("/workspace", servers);
    await client.loadSession("s1", "/workspace", servers);
    expect(seen.slice(1).map((msg) => msg.params?.mcpServers)).toEqual([
      servers,
      servers,
    ]);
  });

  it("does not submit a tool-enabled session when HTTP MCP is unsupported", async () => {
    const seen: Rpc[] = [];
    const { input, output } = fakeAgent((msg, send) => {
      seen.push(msg);
      send({
        id: msg.id,
        result: { agentCapabilities: { loadSession: true } },
      });
    });
    const client = new AcpClient(input, output);
    await client.initialize();
    const servers = [
      {
        type: "http" as const,
        name: "nimbot",
        url: "http://127.0.0.1:1234/mcp",
        headers: [],
      },
    ];
    await expect(client.newSession("/workspace", servers)).rejects.toThrow(
      "does not support HTTP MCP",
    );
    await expect(
      client.loadSession("saved", "/workspace", servers),
    ).rejects.toThrow("does not support HTTP MCP");
    expect(seen).toHaveLength(1);
  });
  it("runs a session and streams updates", async () => {
    const { input, output } = fakeAgent((msg, send) => {
      if (msg.method === "initialize")
        send({ id: msg.id, result: { protocolVersion: 1 } });
      if (msg.method === "session/new")
        send({ id: msg.id, result: { sessionId: "s1" } });
      if (msg.method === "session/prompt") {
        for (const text of ["Hel", "lo"]) {
          send({
            method: "session/update",
            params: {
              sessionId: "s1",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text },
              },
            },
          });
        }
        send({ id: msg.id, result: { stopReason: "end_turn" } });
      }
    });

    const updates: SessionUpdate[] = [];
    const client = new AcpClient(input, output, {
      onUpdate: (_id, u) => updates.push(u),
    });

    await client.initialize();
    const sessionId = await client.newSession("/workspace");
    expect(sessionId).toBe("s1");
    expect(await client.prompt(sessionId, "hi")).toBe("end_turn");
    expect(
      updates.map((u) => (u.content as { text: string }).text).join(""),
    ).toBe("Hello");
  });

  it("answers permission requests and rejects on errors", async () => {
    let outcome: unknown;
    const { input, output } = fakeAgent((msg, send) => {
      if (msg.method === "session/prompt") {
        send({
          id: 99,
          method: "session/request_permission",
          params: {
            sessionId: "s1",
            options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }],
          },
        });
      } else if (msg.id === 99) {
        outcome = msg.result;
        send({ id: 1, error: { code: -32000, message: "boom" } });
      }
    });

    const client = new AcpClient(input, output, {
      onPermission: (o) => o[0]?.optionId,
    });
    await expect(client.prompt("s1", "hi")).rejects.toThrow("boom");
    expect(outcome).toEqual({
      outcome: { outcome: "selected", optionId: "ok" },
    });
  });

  it.each([
    ["waits for an asynchronous decision", async () => "later", "later"],
    [
      "cancels when the handler rejects",
      async () => {
        throw new Error("approver unavailable");
      },
      undefined,
    ],
  ])("%s", async (_name, onPermission, expected) => {
    let outcome: unknown;
    let request: unknown;
    const { input, output } = fakeAgent((msg, send) => {
      if (msg.method === "session/prompt") {
        send({
          id: 99,
          method: "session/request_permission",
          params: {
            sessionId: "s1",
            toolCall: { title: "Read /etc/hostname", kind: "read" },
            options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }],
          },
        });
      } else if (msg.id === 99) {
        outcome = msg.result;
        send({ id: 1, result: { stopReason: "end_turn" } });
      }
    });
    const client = new AcpClient(input, output, {
      onPermission: (_options, info) => {
        request = info;
        return onPermission();
      },
    });
    await client.prompt("s1", "hi");
    expect(request).toEqual({ title: "Read /etc/hostname", kind: "read" });
    expect(outcome).toEqual({
      outcome: expected
        ? { outcome: "selected", optionId: expected }
        : { outcome: "cancelled" },
    });
  });

  it("sends cancel as a notification", async () => {
    const seen: Rpc[] = [];
    const { input, output } = fakeAgent((msg) => seen.push(msg));
    new AcpClient(input, output).cancel("s1");
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([
      { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } },
    ]);
  });

  it("loads a session on a new connection and replays history", async () => {
    const seen: Rpc[] = [];
    const updates: SessionUpdate[] = [];
    const { input, output } = fakeAgent((msg, send) => {
      seen.push(msg);
      if (msg.method === "initialize")
        send({
          id: msg.id,
          result: { agentCapabilities: { loadSession: true } },
        });
      if (msg.method === "session/load") {
        send({
          method: "session/update",
          params: {
            sessionId: "saved",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Previous reply" },
            },
          },
        });
        send({ id: msg.id, result: {} });
      }
      if (msg.method === "session/prompt")
        send({ id: msg.id, result: { stopReason: "end_turn" } });
    });
    const client = new AcpClient(input, output, {
      onUpdate: (_id, update) => updates.push(update),
    });
    await client.initialize();
    await client.loadSession("saved", "/workspace");
    expect(seen[1]?.params).toEqual({
      sessionId: "saved",
      cwd: "/workspace",
      mcpServers: [],
    });
    expect(updates).toHaveLength(1);
    expect(await client.prompt("saved", "continue")).toBe("end_turn");
  });

  it("does not request loading when the engine lacks support", async () => {
    const seen: Rpc[] = [];
    const { input, output } = fakeAgent((msg, send) => {
      seen.push(msg);
      send({ id: msg.id, result: { protocolVersion: 1 } });
    });
    const client = new AcpClient(input, output);
    await client.initialize();
    await expect(client.loadSession("saved", "/workspace")).rejects.toThrow(
      "does not support loading sessions",
    );
    expect(seen).toHaveLength(1);
  });

  it("finishes a cancelled prompt and accepts the next turn", async () => {
    let promptId: number | undefined;
    let turns = 0;
    const { input, output } = fakeAgent((msg, send) => {
      if (msg.method === "session/prompt") {
        promptId = msg.id;
        if (++turns > 1)
          send({ id: msg.id, result: { stopReason: "end_turn" } });
      }
      if (msg.method === "session/cancel")
        send({ id: promptId, result: { stopReason: "cancelled" } });
    });
    const client = new AcpClient(input, output);
    const pending = client.prompt("s1", "long task");
    client.cancel("s1");
    expect(await pending).toBe("cancelled");
    expect(await client.prompt("s1", "next task")).toBe("end_turn");
  });

  it("rejects pending and later requests once the connection closes", async () => {
    const { input, output } = fakeAgent(() => {});
    const client = new AcpClient(input, output);
    const pending = client.initialize();
    input.end();
    await expect(pending).rejects.toThrow("ACP connection closed");
    await expect(client.newSession("/w")).rejects.toThrow(
      "ACP connection closed",
    );
  });

  it("fails requests instead of crashing when the engine's stdin breaks", async () => {
    const output = new PassThrough();
    const client = new AcpClient(new PassThrough(), output);
    const pending = client.initialize();
    output.destroy(new Error("EPIPE"));
    await expect(pending).rejects.toThrow("ACP connection closed");
    client.cancel("s1");
  });

  it("ignores JSON output that is not a protocol message", async () => {
    const { input, output } = fakeAgent((msg, send) => {
      input.write("null\n42\n");
      send({ id: msg.id, result: { sessionId: "s1" } });
    });
    expect(await new AcpClient(input, output).newSession("/w")).toBe("s1");
  });
});
