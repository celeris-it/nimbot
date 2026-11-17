import {
  mkdir,
  lstat,
  readFile,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const providers = [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "google", name: "Google" },
  { id: "openrouter", name: "OpenRouter" },
] as const;
export type ProviderId = (typeof providers)[number]["id"];
export type ProviderCredentials = Partial<Record<ProviderId, string>>;
export interface ProviderStatus {
  id: ProviderId;
  name: string;
  configured: boolean;
}
export function isProviderId(value: string): value is ProviderId {
  return providers.some((provider) => provider.id === value);
}
export function isApiKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/\s/.test(value) &&
    !value.includes("\0")
  );
}

/** Global API keys. Only browser-safe metadata may leave the panel API. */
export async function openProviderCredentials(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.mode & 0o077)
    throw new Error("Provider credential directory must be private");
  const path = join(directory, "keys.json");
  let pending: Promise<void> = Promise.resolve();
  async function read(): Promise<ProviderCredentials> {
    let text: string;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.mode & 0o077)
        throw new Error("Provider credential file must be private");
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("Provider credentials unavailable", { cause: error });
    }
    try {
      const data: unknown = JSON.parse(text);
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        Object.entries(data).some(
          ([id, key]) => !isProviderId(id) || !isApiKey(key),
        )
      )
        throw new Error();
      return data as ProviderCredentials;
    } catch {
      throw new Error("Provider credentials unavailable");
    }
  }
  function change(id: ProviderId, key?: string) {
    const operation = pending.then(async () => {
      const data = await read();
      if (key === undefined) delete data[id];
      else data[id] = key;
      const temporary = join(directory, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(data), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, path);
      } catch {
        throw new Error("Provider credentials could not be saved");
      } finally {
        await rm(temporary, { force: true });
      }
    });
    pending = operation.catch(() => {});
    return operation;
  }
  return {
    async snapshot() {
      await pending;
      return read();
    },
    async list(): Promise<ProviderStatus[]> {
      await pending;
      const data = await read();
      return providers.map((provider) => ({
        ...provider,
        configured: !!data[provider.id],
      }));
    },
    save(id: ProviderId, key: string) {
      if (!isProviderId(id) || !isApiKey(key))
        throw new Error("Invalid provider or API key");
      return change(id, key);
    },
    remove(id: ProviderId) {
      if (!isProviderId(id)) throw new Error("Invalid provider");
      return change(id);
    },
  };
}
