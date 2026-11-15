import { request } from "node:http";

export type DockerApi = (
  path: string,
  method?: string,
  body?: unknown,
) => Promise<{ code: number; body: string }>;

/** Bounded local transport. Never include Docker response bodies in errors: they may contain secrets. */
export function createDockerApi(socketPath: string): DockerApi {
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
