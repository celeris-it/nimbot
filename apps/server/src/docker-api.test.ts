import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDockerApi } from "./docker-api.js";

it("sends JSON bodies over the versioned Unix socket transport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-docker-api-"));
  const socketPath = join(dir, "docker.sock");
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({
        url: req.url,
        method: req.method,
        type: req.headers["content-type"],
        length: req.headers["content-length"],
        body: JSON.parse(body),
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end('{"Id":"created"}');
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const payload = {
      Name: "á-volume",
      Labels: { "io.nimbot.agent-id": "dev" },
    };
    expect(
      await createDockerApi(socketPath)("/volumes/create", "POST", payload),
    ).toEqual({ code: 201, body: '{"Id":"created"}' });
    expect(received).toEqual([
      {
        url: "/v1.47/volumes/create",
        method: "POST",
        type: "application/json",
        length: String(Buffer.byteLength(JSON.stringify(payload))),
        body: payload,
      },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
