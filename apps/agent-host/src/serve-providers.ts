import { serve } from "@hono/node-server";
import { readHostConfig, createHostApi } from "./http.js";
import { readListenConfig } from "./listen-config.js";
import { createOpenCodeApi } from "./opencode-api.js";
import { createOpenCodeAuth } from "./opencode-auth.js";

const config = readHostConfig(process.env);
const openCode = createOpenCodeApi(config.workspace);
let busy = false;
const auth = createOpenCodeAuth(
  openCode.request,
  () => {
    if (busy) return;
    busy = true;
    return () => {
      busy = false;
    };
  },
  () => busy,
  () => process.send?.({ type: "providers.changed" }, () => {}),
);
const app = createHostApi(config, undefined, auth);
const server = serve({
  ...readListenConfig(process.env),
  fetch: (request) => {
    const { pathname } = new URL(request.url);
    return pathname === "/providers" || pathname.startsWith("/providers/")
      ? app.fetch(request)
      : new Response(null, { status: 404 });
  },
});
server.once("listening", () => {
  const address = server.address();
  if (address && typeof address !== "string")
    process.send?.({ type: "host.ready", port: address.port }, () => {});
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  if ("closeIdleConnections" in server) server.closeIdleConnections();
  try {
    await auth.close();
  } finally {
    await openCode.close();
    if (process.connected) process.disconnect?.();
  }
}
function shutdown() {
  void stop().catch(() => {
    process.exitCode = 1;
  });
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
process.once("disconnect", shutdown);
