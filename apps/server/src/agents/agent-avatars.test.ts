import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAgentAvatars } from "./agent-avatars.js";

const bytes = [0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9];
const jpeg = () =>
  new Response(Uint8Array.from(bytes), {
    headers: { "Content-Type": "image/jpeg" },
  });
const exists = (id: string) => id === "agent-a";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "nimbot-avatars-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("downloads once for concurrent callers and reuses the file after restart", async () => {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => jpeg());
  const avatars = createAgentAvatars(directory, exists, request);
  expect(await avatars.get("missing")).toBeUndefined();
  const results = await Promise.all([
    avatars.get("agent-a"),
    avatars.get("agent-a"),
  ]);
  expect(results).toEqual([Buffer.from(bytes), Buffer.from(bytes)]);
  expect(request).toHaveBeenCalledOnce();
  expect(String(request.mock.calls[0]?.[0])).toBe(
    "https://api.dicebear.com/10.x/bottts-neutral/jpg?seed=agent-a&size=256",
  );
  expect(
    await readFile(join(directory, "agents", "agent-a", "avatar.jpg")),
  ).toEqual(Buffer.from(bytes));
  const restored = createAgentAvatars(directory, exists, request);
  expect(await restored.get("agent-a")).toEqual(Buffer.from(bytes));
  expect(request).toHaveBeenCalledOnce();
});

it("rejects rate limits, incorrect types and signatures, and oversized bodies before retrying successfully", async () => {
  const headers = { "Content-Type": "image/jpeg" };
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 429 }))
    .mockResolvedValueOnce(new Response(Uint8Array.from(bytes)))
    .mockResolvedValueOnce(new Response("invalid", { headers }))
    .mockResolvedValueOnce(
      new Response(new Uint8Array(256 * 1024 + 1), { headers }),
    )
    .mockResolvedValueOnce(jpeg());
  const avatars = createAgentAvatars(directory, exists, request);
  for (let attempt = 0; attempt < 4; attempt++)
    expect(await avatars.get("agent-a")).toBeUndefined();
  await expect(
    stat(join(directory, "agents", "agent-a")),
  ).rejects.toHaveProperty("code", "ENOENT");
  expect(await avatars.get("agent-a")).toEqual(Buffer.from(bytes));
});

it("drains an in-flight download before purging and blocks concurrent reads", async () => {
  let respond!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    respond = resolve;
  });
  const request = vi.fn<typeof fetch>().mockReturnValue(response);
  const avatars = createAgentAvatars(directory, exists, request);
  const read = avatars.get("agent-a");
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  const root = join(directory, "agents", "agent-a");
  const remove = vi.fn(() => rm(root, { recursive: true, force: true }));
  const purge = avatars.withPurge("agent-a", remove);
  expect(await avatars.get("agent-a")).toBeUndefined();
  expect(remove).not.toHaveBeenCalled();
  respond(jpeg());
  expect(await read).toBeUndefined();
  await purge;
  expect(remove).toHaveBeenCalledOnce();
  await expect(stat(root)).rejects.toHaveProperty("code", "ENOENT");
});
