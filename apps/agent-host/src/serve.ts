import { serve } from "@hono/node-server";
import { createHostApi, readHostConfig } from "./http.js";

try {
  const config = readHostConfig(process.env);
  const app = createHostApi(config);
  const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 3001 });
  server.on("error", () => {
    console.error("Could not start Agent Host HTTP server.");
    process.exitCode = 1;
  });
  const stop = () => {
    server.close();
    if ("closeIdleConnections" in server) server.closeIdleConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log("Agent Host API listening on port 3001.");
} catch {
  console.error(
    "Invalid Agent Host configuration. Set AGENT_HOST_TOKEN to at least 32 characters without whitespace.",
  );
  process.exitCode = 1;
}
