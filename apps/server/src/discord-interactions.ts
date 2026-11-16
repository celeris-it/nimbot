import { isDiscordId } from "./discord-identity.js";
import type { DiscordApprovalInteraction } from "./discord-approvals.js";

/** Acknowledge before processing a decision. No retries on an uncertain response. */
export async function acknowledgeDiscordApproval(
  interaction: DiscordApprovalInteraction,
  request: typeof fetch = fetch,
): Promise<boolean> {
  if (
    !isDiscordId(interaction.id) ||
    !/^[A-Za-z0-9._-]{1,512}$/.test(interaction.token)
  )
    return false;
  try {
    const response = await request(
      `https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`,
      {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: 6 }),
        signal: AbortSignal.timeout(2000),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}
