import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  hashPassword,
  passwordHashPattern,
  verifyPassword,
} from "./panel-auth.js";

export function validateEnvironmentPassword(env: NodeJS.ProcessEnv) {
  if (env.PANEL_PASSWORD_HASH) {
    if (!passwordHashPattern.test(env.PANEL_PASSWORD_HASH))
      throw new Error(
        "Set a valid PANEL_PASSWORD_HASH using pnpm panel:password.",
      );
  } else if (env.PANEL_PASSWORD && !validPassword(env.PANEL_PASSWORD)) {
    throw new Error(
      "PANEL_PASSWORD must be between 8 and 256 characters long.",
    );
  }
}

export function validPassword(password: string) {
  return password.length >= 8 && password.length <= 256;
}

export async function environmentPasswordHash(env: NodeJS.ProcessEnv) {
  validateEnvironmentPassword(env);
  return (
    env.PANEL_PASSWORD_HASH ||
    (env.PANEL_PASSWORD ? await hashPassword(env.PANEL_PASSWORD) : "")
  );
}

export interface PanelAuthentication {
  readonly ready: boolean;
  readonly pending: boolean;
  verify(password: string): Promise<boolean>;
  setup(
    token: string,
    password: string,
  ): Promise<"saved" | "complete" | "invalid_token">;
  setupRetryAfter(now: number): number;
}

/** One instance is shared by the live panel and backup recovery panel. */
export function createPanelAuthentication(
  stateDir: string,
  environmentHash = "",
) {
  const directory = join(stateDir, "panel-auth");
  const passwordPath = join(directory, "password-hash");
  const tokenPath = join(directory, "setup-token");
  let ready = false;
  let hash = "";
  let token = "";
  let attempts = 0;
  let windowEnd = 0;
  let queue = Promise.resolve();
  function serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function privateFile(path: string) {
    const info = await lstat(path);
    if (!info.isFile() || info.mode & 0o077)
      throw new Error(
        "Panel authentication files must be private regular files.",
      );
    return readFile(path, "utf8");
  }
  return {
    get ready() {
      return ready;
    },
    get pending() {
      return ready && !hash;
    },
    reload() {
      return serialized(async () => {
        ready = false;
        hash = "";
        token = "";
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);
        if (!info.isDirectory() || info.mode & 0o077)
          throw new Error("Panel authentication directory must be private.");
        let saved = environmentHash;
        if (!saved) {
          try {
            saved = await privateFile(passwordPath);
            if (!passwordHashPattern.test(saved))
              throw new Error(
                "The saved panel password hash is invalid. Restore it before starting Nimbot.",
              );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        if (saved && !passwordHashPattern.test(saved))
          throw new Error(
            "The saved panel password hash is invalid. Restore it before starting Nimbot.",
          );
        if (saved) {
          await rm(tokenPath, { force: true });
          hash = saved;
        } else {
          const nextToken = randomBytes(32).toString("hex");
          const temporary = join(
            directory,
            `setup-token-${randomBytes(8).toString("hex")}.tmp`,
          );
          try {
            await writeFile(temporary, nextToken, { mode: 0o600, flag: "wx" });
            await rename(temporary, tokenPath);
          } finally {
            await rm(temporary, { force: true });
          }
          token = nextToken;
        }
        ready = true;
      });
    },
    async verify(password: string) {
      const current = hash;
      if (!ready || !current) return false;
      const matches = await verifyPassword(password, current);
      return ready && hash === current && matches;
    },
    setupRetryAfter(now: number) {
      if (now >= windowEnd) {
        attempts = 0;
        windowEnd = now + 15 * 60_000;
      }
      if (attempts >= 5) return Math.ceil((windowEnd - now) / 1000);
      attempts++;
      return 0;
    },
    setup(submittedToken: string, password: string) {
      return serialized(async () => {
        if (!ready) throw new Error("Panel authentication is unavailable.");
        if (hash) return "complete" as const;
        if (
          !/^[a-f0-9]{64}$/.test(submittedToken) ||
          !token ||
          !timingSafeEqual(Buffer.from(submittedToken), Buffer.from(token))
        )
          return "invalid_token" as const;
        if (!validPassword(password))
          throw new Error("Invalid password length.");
        const nextHash = await hashPassword(password);
        const temporary = join(
          directory,
          `password-${randomBytes(8).toString("hex")}.tmp`,
        );
        try {
          await writeFile(temporary, nextHash, { mode: 0o600, flag: "wx" });
          // Linking publishes a complete file without replacing an existing password.
          await link(temporary, passwordPath);
        } finally {
          await rm(temporary, { force: true });
        }
        hash = nextHash;
        token = "";
        attempts = 0;
        // Once published, a leftover token cannot authorize another setup.
        await rm(tokenPath, { force: true }).catch(() => {});
        return "saved" as const;
      });
    },
  };
}
