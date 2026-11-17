import {
  mkdtemp,
  rm,
  stat,
  chmod,
  writeFile,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { openProviderCredentials } from "./provider-credentials.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-providers-"));
  dirs.push(dir);
  const directory = join(dir, "secrets");
  return { directory, store: await openProviderCredentials(directory) };
}

it("persists private global keys without losing concurrent edits and returns only metadata", async () => {
  const { directory, store } = await setup();
  expect(await store.snapshot()).toEqual({});
  await Promise.all([
    store.save("openai", "private-a"),
    store.save("anthropic", "private-b"),
  ]);
  expect(await store.snapshot()).toEqual({
    openai: "private-a",
    anthropic: "private-b",
  });
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(directory, "keys.json"))).mode & 0o777).toBe(0o600);
  const reopened = await openProviderCredentials(directory);
  await Promise.all([
    reopened.save("openai", "replacement"),
    reopened.remove("anthropic"),
  ]);
  expect(await reopened.snapshot()).toEqual({ openai: "replacement" });
  expect(await reopened.list()).toEqual([
    { id: "openai", name: "OpenAI", configured: true },
    { id: "anthropic", name: "Anthropic", configured: false },
    { id: "google", name: "Google", configured: false },
    { id: "openrouter", name: "OpenRouter", configured: false },
  ]);
  expect(await readFile(join(directory, "keys.json"), "utf8")).not.toContain(
    "private-",
  );
  await reopened.remove("openai");
  expect(await reopened.snapshot()).toEqual({});
});

it("fails closed for corrupt or publicly readable secrets and recovers after a failed write", async () => {
  const { directory, store } = await setup();
  const file = join(directory, "keys.json");
  await store.save("openai", "private-key");
  await chmod(file, 0o644);
  await expect(store.snapshot()).rejects.toThrow("unavailable");
  await expect(store.save("google", "another")).rejects.toThrow();
  await chmod(file, 0o600);
  await store.save("google", "another");
  await writeFile(file, '{"openai":"private-corrupt');
  await expect(store.snapshot()).rejects.toThrow(
    "Provider credentials unavailable",
  );
  await chmod(directory, 0o755);
  await expect(openProviderCredentials(directory)).rejects.toThrow(
    "must be private",
  );
});

it("rejects empty, excessive, whitespace and NUL-containing keys", async () => {
  const { store } = await setup();
  for (const key of ["", " ", "a\nb", "a\0b", "x".repeat(4097)])
    expect(() => store.save("openai", key)).toThrow("Invalid");
  expect(await store.snapshot()).toEqual({});
});
