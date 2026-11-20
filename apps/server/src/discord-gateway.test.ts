import { afterEach, expect, it, vi } from "vitest";
import { createDiscordGateway } from "./discord-gateway.js";
class Socket extends EventTarget {
  sent: Array<{ op: number; d: Record<string, unknown> }> = [];
  close = vi.fn();
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  receive(payload: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(payload) }),
    );
  }
}
afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  const urls: string[] = [];
  let valid = true;
  const message = vi.fn();
  const interaction = vi.fn();
  const gateway = createDiscordGateway(
    {
      token: "secret",
      botId: "123",
      ownerId: "456",
      isCurrent: () => valid,
      message,
      interaction,
    },
    (url) => {
      urls.push(url);
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    () => 0.5,
  );
  const ready = (socket: Socket) => {
    socket.receive({ op: 10, d: { heartbeat_interval: 1000 } });
    socket.receive({
      op: 0,
      s: 1,
      t: "READY",
      d: { user: { id: "123" }, session_id: "session" },
    });
  };
  return {
    gateway,
    sockets,
    urls,
    message,
    interaction,
    ready,
    invalidate: () => {
      valid = false;
    },
  };
}
it("identifies with DM intent and accepts only the owner's non-bot private messages", () => {
  const f = fixture();
  const socket = f.sockets[0]!;
  f.ready(socket);
  expect(socket.sent[0]).toMatchObject({ op: 2, d: { intents: 4096 } });
  const data = {
    id: "789",
    channel_id: "987",
    author: { id: "456" },
    content: "hello",
  };
  for (const change of [
    { guild_id: "1" },
    { author: { id: "999" } },
    { author: { id: "456", bot: true } },
    { webhook_id: "1" },
    { content: " " },
  ])
    socket.receive({
      op: 0,
      s: 2,
      t: "MESSAGE_CREATE",
      d: { ...data, ...change },
    });
  expect(f.message).not.toHaveBeenCalled();
  socket.receive({ op: 0, s: 3, t: "MESSAGE_CREATE", d: data });
  expect(f.message).toHaveBeenCalledWith({
    id: "789",
    channelId: "987",
    content: "hello",
  });
  f.gateway.close();
});
it("reconnects after missing heartbeat ACK and resumes the session", () => {
  const f = fixture();
  f.ready(f.sockets[0]!);
  vi.advanceTimersByTime(1500);
  expect(f.gateway.getState()).toBe("reconnecting");
  vi.advanceTimersByTime(5000);
  const next = f.sockets[1]!;
  next.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  expect(next.sent[0]).toEqual({
    op: 6,
    d: { token: "secret", session_id: "session", seq: 1 },
  });
  next.receive({ op: 0, s: 2, t: "RESUMED", d: {} });
  expect(f.gateway.getState()).toBe("ready");
  f.gateway.close();
});
it("stops on revoked configuration and cancels scheduled reconnections", () => {
  const f = fixture();
  f.ready(f.sockets[0]!);
  f.invalidate();
  vi.advanceTimersByTime(500);
  expect(f.gateway.getState()).toBe("stopped");
  vi.advanceTimersByTime(30000);
  expect(f.sockets).toHaveLength(1);
  expect(f.message).not.toHaveBeenCalled();
});
it("drops an invalid session and identifies again", () => {
  const f = fixture();
  f.ready(f.sockets[0]!);
  f.sockets[0]!.receive({ op: 9, d: false });
  vi.advanceTimersByTime(5000);
  f.sockets[1]!.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  expect(f.sockets[1]!.sent[0]?.op).toBe(2);
  f.gateway.close();
});

it.each(["ap:abcdefghijkl:y", "sc:abcdefghijklmnop:y"])(
  "accepts interaction %s only from the owner's DM for this application",
  (customId) => {
    const f = fixture();
    const socket = f.sockets[0]!;
    f.ready(socket);
    const interaction = {
      id: "1",
      type: 3,
      application_id: "123",
      user: { id: "456" },
      channel_id: "789",
      message: { id: "999" },
      token: "private",
      data: { custom_id: customId },
    };
    for (const change of [
      { guild_id: "1" },
      { application_id: "2" },
      { user: { id: "2" } },
      { user: { id: "456", bot: true } },
      { data: { custom_id: "other" } },
    ])
      socket.receive({
        op: 0,
        s: 2,
        t: "INTERACTION_CREATE",
        d: { ...interaction, ...change },
      });
    expect(f.interaction).not.toHaveBeenCalled();
    socket.receive({ op: 0, s: 3, t: "INTERACTION_CREATE", d: interaction });
    expect(f.interaction).toHaveBeenCalledWith({
      id: "1",
      botId: "123",
      ownerId: "456",
      channelId: "789",
      messageId: "999",
      token: "private",
      customId,
    });
    f.gateway.close();
  },
);

it("preserves the session on reconnect and accepts replayed DMs before RESUMED", () => {
  const f = fixture();
  const first = f.sockets[0]!;
  first.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  first.receive({
    op: 0,
    s: 1,
    t: "READY",
    d: {
      user: { id: "123" },
      session_id: "session",
      resume_gateway_url: "wss://gateway-us-east1-b.discord.gg/",
    },
  });
  first.receive({ op: 7, d: null });
  expect(first.close).toHaveBeenCalledWith(4000);
  vi.advanceTimersByTime(5000);
  expect(f.urls[1]).toBe(
    "wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json",
  );
  const next = f.sockets[1]!;
  next.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  expect(next.sent[0]).toMatchObject({ op: 6, d: { seq: 1 } });
  next.receive({
    op: 0,
    s: 2,
    t: "MESSAGE_CREATE",
    d: {
      id: "789",
      channel_id: "987",
      author: { id: "456" },
      content: "replayed",
    },
  });
  expect(f.message).toHaveBeenCalledWith({
    id: "789",
    channelId: "987",
    content: "replayed",
  });
  next.receive({ op: 0, s: 3, t: "RESUMED", d: {} });
  expect(f.gateway.getState()).toBe("ready");
  f.gateway.close();
});

it.each([
  "wss://evil.example/",
  "ws://gateway.discord.gg/",
  "wss://secret@gateway.discord.gg/",
])("never sends credentials to an invalid resume endpoint %s", (resumeUrl) => {
  const f = fixture();
  f.sockets[0]!.receive({
    op: 0,
    s: 1,
    t: "READY",
    d: {
      user: { id: "123" },
      session_id: "session",
      resume_gateway_url: resumeUrl,
    },
  });
  vi.advanceTimersByTime(5000);
  expect(
    f.urls.every(
      (url) => url === "wss://gateway.discord.gg/?v=10&encoding=json",
    ),
  ).toBe(true);
  f.gateway.close();
});

it("ignores approval interactions from group and other private-channel contexts", () => {
  const f = fixture();
  const socket = f.sockets[0]!;
  f.ready(socket);
  const data = {
    id: "1",
    type: 3,
    application_id: "123",
    user: { id: "456" },
    channel_id: "789",
    message: { id: "999" },
    token: "private",
    data: { custom_id: "ap:abcdefghijkl:y" },
  };
  for (const extra of [{ context: 2 }, { channel: { type: 3 } }])
    socket.receive({
      op: 0,
      s: 2,
      t: "INTERACTION_CREATE",
      d: { ...data, ...extra },
    });
  expect(f.interaction).not.toHaveBeenCalled();
  f.gateway.close();
});

it("admits attachment-only DMs with sanitized metadata and no CDN URL", () => {
  const f = fixture();
  const socket = f.sockets[0]!;
  f.ready(socket);
  socket.receive({
    op: 0,
    s: 2,
    t: "MESSAGE_CREATE",
    d: {
      id: "789",
      channel_id: "987",
      author: { id: "456" },
      content: "",
      attachments: [
        {
          id: "1",
          filename: "../file.txt",
          size: 5,
          url: "https://example.com",
        },
      ],
    },
  });
  expect(f.message).toHaveBeenCalledExactlyOnceWith({
    id: "789",
    channelId: "987",
    content: "",
    attachment: { document: { id: "1", name: "file.txt", size: 5 } },
  });
  f.gateway.close();
});
