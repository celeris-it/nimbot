// Opt-in native Server test: replace only grammY's transport in the Server.
// NODE_OPTIONS is excluded from Host environments, so Hosts use their real code.
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";

const require = createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
);
const transport = require.resolve("node-fetch", {
  paths: [dirname(require.resolve("grammy"))],
});
require(transport);
const fixtureFetch = async (url, options = {}) => {
  const endpoint = new URL(url);
  if (endpoint.hostname !== "api.telegram.org")
    throw new Error("Unexpected fixture network request");
  let result;
  if (endpoint.pathname.endsWith("/getMe"))
    result = {
      id: Number(endpoint.pathname.match(/\/bot(\d+):/)[1]),
      is_bot: true,
      first_name: "Fixture",
      username: "fixture_bot",
    };
  else if (endpoint.pathname.endsWith("/deleteWebhook")) result = true;
  else if (endpoint.pathname.endsWith("/getUpdates")) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(done, 1000);
      function done() {
        options.signal?.removeEventListener("abort", abort);
        resolve();
      }
      function abort() {
        clearTimeout(timer);
        reject(new Error("Fixture polling aborted"));
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
    result = [];
  } else throw new Error("Unexpected fixture Telegram method");
  return new globalThis.Response(JSON.stringify({ ok: true, result }), {
    headers: { "Content-Type": "application/json" },
  });
};

fixtureFetch.default = fixtureFetch;
require.cache[transport].exports = fixtureFetch;
