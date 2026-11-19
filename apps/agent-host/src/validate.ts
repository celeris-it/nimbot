import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import type { ZodType, z } from "zod";

/**
 * Query, path and form validation that answers with the route's own `{ error }` body.
 * Without `message`, the first issue's message is used, so schemas list their fields in check order.
 */
export const validated = <
  Target extends "query" | "param" | "form",
  Schema extends ZodType,
>(
  target: Target,
  schema: Schema,
  message?: string,
) =>
  zValidator(target, schema, (result, c) =>
    result.success
      ? undefined
      : c.json({ error: message ?? result.error.issues[0]!.message }, 400),
  );

/**
 * JSON bodies are parsed here rather than by Hono's JSON validator, which skips bodies sent without
 * a JSON content type and answers malformed JSON in its own words.
 */
export async function parseJson<Schema extends ZodType>(
  c: Context,
  schema: Schema,
  messages: { malformed: string; invalid?: string },
): Promise<
  { data: z.infer<Schema>; response?: never } | { response: Response }
> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { response: c.json({ error: messages.malformed }, 400) };
  }
  const result = schema.safeParse(body);
  return result.success
    ? { data: result.data as z.infer<Schema> }
    : {
        response: c.json(
          { error: messages.invalid ?? result.error.issues[0]!.message },
          400,
        ),
      };
}
