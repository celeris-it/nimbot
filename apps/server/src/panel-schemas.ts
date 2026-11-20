import { z } from "zod";
import { isDiscordId } from "./discord-identity.js";
import { isApiKey } from "./provider-contracts.js";

/** Form field schemas for the panel API. Each route supplies its own error message. */
export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const providerKeyForm = z.object({ key: z.custom<string>(isApiKey) });

export const peerGrantForm = z.object({
  target: z.string(),
  permission: z.enum(["note", "delegate"]),
});

export const approvalRuleForm = z.object({
  actionType: z.string().trim(),
  target: z.string().trim(),
  effect: z.enum(["ask", "deny", "allow"]),
  // An empty field means "no expiry"; Number() keeps the previous parsing of the rest.
  ttlDays: z
    .string()
    .transform((days) => (days === "" ? undefined : Number(days)))
    .pipe(z.number().int().min(1).max(365).optional()),
});

export const memoryAccessForm = z.object({
  enabled: z.enum(["true", "false"]),
});

export const settingsForm = z.object({
  name: z.string().trim().min(1).max(128),
  instructions: z.string().max(4000),
});

export const discordConfigureForm = z.object({
  ownerId: z.custom<string>(isDiscordId),
  token: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,256}$/),
});

export const discordTestForm = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});

export const tokenForm = z.object({ token: z.string().trim().min(1).max(256) });

export const registerAgentForm = z.object({
  name: z.string(),
  ownerId: z
    .string()
    .regex(/^[1-9]\d*$/)
    .refine((id) => Number.isSafeInteger(Number(id)))
    .transform(Number),
  token: z.string(),
  instructions: z.string().default(""),
});

/** The agent being confirmed is the one in the path. */
export const confirmForm = (id: string) => z.object({ confirm: z.literal(id) });

/** Removal, deletion and container actions also require the path to be a valid agent ID. */
export const removeResourcesForm = (id: string) =>
  z
    .object({
      confirm: z.literal(id),
      deleteData: z.enum(["true", "false"]).optional(),
    })
    .refine(() => AGENT_ID.test(id));

export const deleteAgentForm = (id: string) =>
  z
    .object({ confirm: z.literal(id), deleteData: z.enum(["true", "false"]) })
    .refine(() => AGENT_ID.test(id));

export const containerForm = (id: string) =>
  z
    .object({
      action: z.enum(["start", "stop"]),
      confirm: z.unknown().optional(),
    })
    .refine(
      (form) =>
        AGENT_ID.test(id) && (form.action !== "stop" || form.confirm === id),
    );

export const loginAttemptParams = z.object({
  attempt: z.string().regex(/^[a-f0-9-]{36}$/),
});

export const delegationParams = z.object({
  delegationId: z
    .string()
    .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
});

/** Unknown fields are reported before missing or malformed ones. */
export const scheduleForm = z.strictObject({
  deliveryChannel: z.enum(["telegram", "discord"]).optional(),
  name: z.string(),
  prompt: z.string(),
  cadence: z.string(),
  timeZone: z.string(),
});
