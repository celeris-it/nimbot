import { isIP } from "node:net";

/** Runner processes can bind separate loopback ports; containers keep the legacy defaults. */
export function readListenConfig(env: NodeJS.ProcessEnv): {
  hostname: string;
  port: number;
} {
  const hostname = env.AGENT_HOST_BIND_ADDRESS ?? "0.0.0.0";
  if (!isIP(hostname))
    throw new Error("AGENT_HOST_BIND_ADDRESS must be an IPv4 or IPv6 address.");
  const value = env.AGENT_HOST_PORT ?? "3001";
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535)
    throw new Error("AGENT_HOST_PORT must be between 1 and 65535.");
  return { hostname, port };
}
