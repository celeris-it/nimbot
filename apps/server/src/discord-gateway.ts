import type { DiscordApprovalInteraction } from "./discord-approvals.js";
import { isDiscordId } from "./discord-identity.js";

export interface DiscordDirectMessage {
  id: string;
  channelId: string;
  content: string;
}
type Socket = Pick<WebSocket, "send" | "close" | "addEventListener">;
type State = "connecting" | "ready" | "reconnecting" | "failed" | "stopped";
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

/** Server-only transport. Callers must persist accepted messages before executing them. */
export function createDiscordGateway(
  options: {
    token: string;
    botId: string;
    ownerId: string;
    isCurrent(): boolean;
    message(message: DiscordDirectMessage): void;
    interaction?(interaction: DiscordApprovalInteraction): void;
  },
  connect: (url: string) => Socket = (url) => new WebSocket(url),
  random = Math.random,
) {
  let state: State = "connecting";
  let socket: Socket | undefined;
  let sequence: number | null = null;
  let session: string | undefined;
  const initialUrl = "wss://gateway.discord.gg/?v=10&encoding=json";
  let resumeUrl = initialUrl;
  let ack = true;
  let stopped = false;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  function clearTimers() {
    clearTimeout(heartbeat);
    clearTimeout(timeout);
  }
  function close() {
    stopped = true;
    state = "stopped";
    clearTimers();
    clearTimeout(retry);
    const current = socket;
    socket = undefined;
    current?.close(1000);
  }
  function current() {
    if (stopped) return false;
    if (!options.isCurrent()) {
      close();
      return false;
    }
    return true;
  }
  function send(op: number, d: unknown) {
    socket?.send(JSON.stringify({ op, d }));
  }
  function reconnect(reset = false) {
    if (stopped || retry) return;
    clearTimers();
    if (reset) {
      session = undefined;
      sequence = null;
      resumeUrl = initialUrl;
    }
    const previous = socket;
    socket = undefined;
    previous?.close(4000);
    state = "reconnecting";
    retry = setTimeout(() => {
      retry = undefined;
      open();
    }, 5000);
  }
  function open() {
    if (!current()) return;
    ack = true;
    let active: Socket;
    try {
      active = connect(session ? resumeUrl : initialUrl);
    } catch {
      reconnect();
      return;
    }
    socket = active;
    timeout = setTimeout(() => reconnect(), 15000);
    active.addEventListener("message", (event) => {
      if (socket !== active || !current()) return;
      try {
        const payload = object(
          JSON.parse(String((event as MessageEvent).data)),
        );
        const data = object(payload.d);
        if (payload.op === 10) {
          const interval = data.heartbeat_interval;
          if (
            typeof interval !== "number" ||
            !Number.isFinite(interval) ||
            interval < 1000 ||
            interval > 300000
          ) {
            reconnect();
            return;
          }
          clearTimeout(heartbeat);
          const beat = () => {
            if (socket !== active || !current()) return;
            if (!ack) {
              reconnect();
              return;
            }
            ack = false;
            send(1, sequence);
            heartbeat = setTimeout(beat, interval);
          };
          heartbeat = setTimeout(beat, interval * random());
          if (session && sequence !== null)
            send(6, {
              token: options.token,
              session_id: session,
              seq: sequence,
            });
          else
            send(2, {
              token: options.token,
              intents: 1 << 12,
              properties: {
                os: process.platform,
                browser: "nimbot",
                device: "nimbot",
              },
            });
        } else if (payload.op === 11) ack = true;
        else if (payload.op === 1) {
          ack = false;
          send(1, sequence);
        } else if (payload.op === 7) reconnect();
        else if (payload.op === 9) reconnect(payload.d !== true);
        else if (payload.op === 0) {
          if (
            typeof payload.s !== "number" ||
            !Number.isSafeInteger(payload.s)
          ) {
            reconnect();
            return;
          }
          if (payload.t === "READY") {
            if (
              object(data.user).id !== options.botId ||
              typeof data.session_id !== "string"
            ) {
              stopped = true;
              state = "failed";
              clearTimers();
              socket = undefined;
              active.close(1000);
              return;
            }
            if (data.resume_gateway_url !== undefined) {
              const url = new URL(String(data.resume_gateway_url));
              if (
                url.protocol !== "wss:" ||
                !/^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(url.hostname) ||
                url.username ||
                url.password ||
                url.port
              )
                throw new Error("Invalid Discord Gateway URL");
              url.search = "?v=10&encoding=json";
              resumeUrl = url.toString();
            }
            session = data.session_id;
            state = "ready";
            clearTimeout(timeout);
          } else if (payload.t === "RESUMED") {
            state = "ready";
            clearTimeout(timeout);
          } else if (
            payload.t === "INTERACTION_CREATE" &&
            (state === "ready" || session !== undefined)
          ) {
            const user = object(data.user);
            const component = object(data.data);
            const message = object(data.message);
            if (
              data.type === 3 &&
              (data.context === undefined || data.context === 1) &&
              (object(data.channel).type === undefined ||
                object(data.channel).type === 1) &&
              !data.guild_id &&
              !data.guild &&
              user.id === options.ownerId &&
              user.bot !== true &&
              data.application_id === options.botId &&
              isDiscordId(data.id) &&
              isDiscordId(data.channel_id) &&
              isDiscordId(message.id) &&
              typeof data.token === "string" &&
              /^[A-Za-z0-9._-]{1,512}$/.test(data.token) &&
              typeof component.custom_id === "string" &&
              /^ap:[A-Za-z0-9_-]{12}:[yn]$/.test(component.custom_id)
            ) {
              options.interaction?.({
                id: data.id,
                token: data.token,
                botId: options.botId,
                ownerId: options.ownerId,
                channelId: data.channel_id,
                messageId: message.id,
                customId: component.custom_id,
              });
            }
          } else if (
            payload.t === "MESSAGE_CREATE" &&
            (state === "ready" || session !== undefined)
          ) {
            const author = object(data.author);
            if (
              !data.guild_id &&
              author.id === options.ownerId &&
              author.bot !== true &&
              !data.webhook_id &&
              isDiscordId(data.id) &&
              isDiscordId(data.channel_id) &&
              typeof data.content === "string" &&
              data.content.trim()
            ) {
              options.message({
                id: data.id,
                channelId: data.channel_id,
                content: data.content,
              });
            }
          }
          sequence = payload.s;
        }
      } catch {
        reconnect();
      }
    });
    active.addEventListener("close", (event) => {
      if (socket !== active || stopped) return;
      const code = (event as CloseEvent).code;
      if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) {
        stopped = true;
        state = "failed";
        clearTimers();
        socket = undefined;
      } else reconnect(code === 4007 || code === 4009);
    });
    active.addEventListener("error", () => {
      if (socket === active) reconnect();
    });
  }
  open();
  return { getState: () => state, close };
}
