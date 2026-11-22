import { Ajv, type Options } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { default as formats } from "ajv-formats";

type ArgumentsValidator = (
  input: unknown,
) => Record<string, unknown> | undefined;

const options: Options = {
  strict: true,
  // These are schema style checks, not JSON Schema validity constraints.
  strictRequired: false,
  strictTypes: false,
  strictTuples: false,
  allowMatchingProperties: true,
  logger: false,
  addUsedSchema: false,
  ownProperties: true,
  // Pinned arguments are checked as supplied, never repaired or supplemented.
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
};
const current = new Ajv2020(options);
const draft7 = new Ajv(options);
formats.default(current);
formats.default(draft7);
const cache = new Map<string, ArgumentsValidator | undefined>();
const MAX_CACHE_ENTRIES = 64;
const MAX_BYTES = 16_384;

function json(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => json(item, depth + 1));
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    return (
      (prototype === Object.prototype || prototype === null) &&
      Object.values(value).every((item) => json(item, depth + 1))
    );
  }
  return false;
}

/** Compile synchronous schemas without a reference loader or remotely supplied keywords. */
export function compileMcpArguments(
  schema: Record<string, unknown>,
): ArgumentsValidator | undefined {
  try {
    if (schema.type !== "object" || !json(schema)) return undefined;
    const encoded = JSON.stringify(schema);
    if (Buffer.byteLength(encoded) > MAX_BYTES) return undefined;
    if (cache.has(encoded)) return cache.get(encoded);
    let validator: ArgumentsValidator | undefined;
    try {
      const dialect = schema.$schema;
      const compiler =
        dialect === undefined ||
        dialect === "https://json-schema.org/draft/2020-12/schema"
          ? current
          : dialect === "http://json-schema.org/draft-07/schema#"
            ? draft7
            : undefined;
      // Snapshot the schema so a caller cannot mutate a compiled constraint.
      const validate = compiler?.compile(JSON.parse(encoded) as object);
      if (validate && !("$async" in validate)) {
        validator = (input) => {
          try {
            if (
              !input ||
              typeof input !== "object" ||
              Array.isArray(input) ||
              !json(input) ||
              Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES ||
              !validate(input)
            )
              return undefined;
            return input as Record<string, unknown>;
          } catch {
            return undefined;
          }
        };
      }
    } catch {
      // Invalid, unsupported, asynchronous and unresolved schemas fail closed.
    } finally {
      // Ajv also caches by object identity. Keep only the bounded cache below;
      // removeSchema preserves the built-in metaschemas and compiled validators.
      current.removeSchema();
      draft7.removeSchema();
    }
    if (cache.size === MAX_CACHE_ENTRIES)
      cache.delete(cache.keys().next().value!);
    cache.set(encoded, validator);
    return validator;
  } catch {
    return undefined;
  }
}
