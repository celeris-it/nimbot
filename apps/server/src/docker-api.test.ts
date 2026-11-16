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

import { vi } from "vitest";
import type { DockerApi } from "./docker-api.js";

it("retries reads after a transport failure or a 5xx answer, within a bound", async () => {
  const transport = vi
    .fn<DockerApi>()
    .mockRejectedValueOnce(new Error("socket hang up"))
    .mockResolvedValueOnce({ code: 503, body: "" })
    .mockResolvedValue({ code: 200, body: "{}" });
  const call = createDockerApi("/unused", [0, 0], transport);
  expect(await call("/containers/x/json")).toEqual({ code: 200, body: "{}" });
  expect(transport).toHaveBeenCalledTimes(3);

  const down = vi.fn<DockerApi>().mockRejectedValue(new Error("refused"));
  await expect(
    createDockerApi("/unused", [0, 0], down)("/containers/json"),
  ).rejects.toThrow("refused");
  expect(down).toHaveBeenCalledTimes(3);

  const broken = vi.fn<DockerApi>().mockResolvedValue({ code: 500, body: "x" });
  expect(await createDockerApi("/unused", [0], broken)("/info")).toEqual({
    code: 500,
    body: "x",
  });
  expect(broken).toHaveBeenCalledTimes(2);
});

it("never repeats a mutation whose outcome is unknown and does not retry client errors", async () => {
  for (const method of ["POST", "DELETE"]) {
    const lost = vi.fn<DockerApi>().mockRejectedValue(new Error("reset"));
    await expect(
      createDockerApi("/unused", [0, 0], lost)(
        "/containers/create",
        method,
        {},
      ),
    ).rejects.toThrow("reset");
    expect(lost).toHaveBeenCalledOnce();
    const failed = vi
      .fn<DockerApi>()
      .mockResolvedValue({ code: 500, body: "" });
    expect(
      (await createDockerApi("/unused", [0, 0], failed)("/x", method, {})).code,
    ).toBe(500);
    expect(failed).toHaveBeenCalledOnce();
  }
  const missing = vi.fn<DockerApi>().mockResolvedValue({ code: 404, body: "" });
  expect((await createDockerApi("/unused", [0, 0], missing)("/x")).code).toBe(
    404,
  );
  expect(missing).toHaveBeenCalledOnce();
});

it("logs only the errno name of a failed request, never its message or path", async () => {
  vi.stubEnv("NIMBOT_LOG", "");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const denied = Object.assign(new Error("connect EACCES /secret/path"), {
      code: "EACCES",
    });
    const transport = vi.fn<DockerApi>().mockRejectedValue(denied);
    await expect(
      createDockerApi("/unused", [], transport)("/_ping"),
    ).rejects.toThrow("EACCES");
    const line = String(error.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      event: "docker.request_failed",
      code: "EACCES",
    });
    expect(line).not.toContain("/secret/path");
  } finally {
    error.mockRestore();
    vi.unstubAllEnvs();
  }
});
