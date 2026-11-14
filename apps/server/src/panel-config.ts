import { passwordHashPattern } from "./panel-auth.js";

export interface PanelConfig {
  passwordHash: string;
  origin: string;
  hostname: string;
  port: number;
}

export function readPanelConfig(env: NodeJS.ProcessEnv): PanelConfig {
  const passwordHash = env.PANEL_PASSWORD_HASH ?? "";
  if (!passwordHashPattern.test(passwordHash))
    throw new Error("Set PANEL_PASSWORD_HASH using pnpm panel:password.");
  const url = new URL(env.PANEL_URL ?? "http://localhost:3000");
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  ) {
    throw new Error("PANEL_URL must be an HTTPS origin, or HTTP on loopback.");
  }
  const port = Number(env.PANEL_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PANEL_PORT must be between 1 and 65535.");
  return {
    passwordHash,
    origin: url.origin,
    port,
    hostname: env.PANEL_HOST ?? "127.0.0.1",
  };
}
