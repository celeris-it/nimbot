import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { log } from "./logger.js";

export type DockerApi = (
  path: string,
  method?: string,
  body?: unknown,
) => Promise<{ code: number; body: string }>;

/** Waits between the attempts that follow the first one; its length bounds read retries. */
export const DOCKER_READ_RETRY_DELAYS_MS: readonly number[] = [200, 600];

/**
 * Bounded local transport. Never include Docker response bodies in errors: they may contain secrets.
 * Only reads are retried (transport failures and 5xx answers). A create, start, stop, or delete
 * whose outcome is unknown is never repeated; callers track those as uncertain operations.
 */
export function createDockerApi(
  socketPath: string,
  retryDelaysMs: readonly number[] = DOCKER_READ_RETRY_DELAYS_MS,
  transport: DockerApi = createTransport(socketPath),
): DockerApi {
  return async (path, method = "GET", body) => {
    for (let failures = 0; ; failures++) {
      const wait = method === "GET" ? retryDelaysMs[failures] : undefined;
      try {
        const result = await transport(path, method, body);
        if (result.code < 500 || wait === undefined) return result;
      } catch (error) {
        if (wait === undefined) {
          const code = (error as NodeJS.ErrnoException | undefined)?.code;
          log.error("docker.request_failed", {
            method,
            attempts: failures + 1,
            // Errno name only (for example EACCES); never a message or path.
            ...(typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)
              ? { code }
              : {}),
          });
          throw error;
        }
      }
      log.warn("docker.read_retry", { method, attempt: failures + 1 });
      await delay(wait);
    }
  };
}

function createTransport(socketPath: string): DockerApi {
  return (path, method = "GET", body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          socketPath,
          path: `/v1.47${path}`,
          method,
          headers:
            payload === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(payload),
                },
        },
        (res) => {
          let result = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            result += chunk;
            if (result.length > 65536)
              req.destroy(new Error("Docker response too large"));
          });
          res.on("end", () =>
            resolve({ code: res.statusCode ?? 500, body: result }),
          );
          res.on("error", reject);
        },
      );
      req.setTimeout(15000, () =>
        req.destroy(new Error("Docker request timed out")),
      );
      req.on("error", reject);
      req.end(payload);
    });
}
