import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import type { ZodType, z } from "zod";

/** Path and query validation that answers with the route's own `{ error }` body. */
export const validated = <
  Target extends "query" | "param",
  Schema extends ZodType,
>(
  target: Target,
  schema: Schema,
  message: string,
) =>
  zValidator(target, schema, (result, c) =>
    result.success ? undefined : c.json({ error: message }, 400),
  );

/**
 * Parses submitted form fields inside the handler, after the route's own 404 and 503 checks.
 * Hono's form validator would run first and ignores bodies sent without a form content type.
 */
export async function parseForm<Schema extends ZodType>(
  c: Context,
  schema: Schema,
  message: string,
): Promise<
  { data: z.infer<Schema>; response?: never } | { response: Response }
> {
  const result = schema.safeParse(await c.req.parseBody({ all: true }));
  return result.success
    ? { data: result.data as z.infer<Schema> }
    : { response: c.json({ error: message }, 400) };
}
