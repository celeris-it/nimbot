/** Settings of the removed pre-configured agent; a stale .env may still set them. */
const LEGACY_SETTINGS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_IDS",
  "TELEGRAM_OWNER_USER_ID",
  "AGENT_ID",
  "AGENT_NAME",
  "AGENT_HOST_TOKEN",
  "AGENT_HOST_URL",
  "AGENT_CONTAINER_NAME",
] as const;

/** Names (never values) of legacy settings that are set, so they can be reported as ignored. */
export function findLegacySettings(env: NodeJS.ProcessEnv): string[] {
  return LEGACY_SETTINGS.filter((name) => env[name]?.trim());
}
