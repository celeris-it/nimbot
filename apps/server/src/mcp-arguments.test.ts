import { expect, it } from "vitest";
import { compileMcpArguments } from "./mcp-arguments.js";

const schema = {
  type: "object",
  required: ["query", "limit"],
  properties: {
    query: {
      type: "string",
      minLength: 2,
      maxLength: 20,
      pattern: "^[a-z ]+$",
    },
    limit: { type: "integer", minimum: 1, maximum: 10 },
    tags: {
      type: "array",
      items: { enum: ["public", "private"] },
      uniqueItems: true,
      maxItems: 2,
    },
    filters: {
      type: "object",
      properties: { email: { type: "string", format: "email" } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

it("enforces pinned nested constraints, types, required fields and formats", () => {
  const validate = compileMcpArguments(schema)!;
  const good = {
    query: "release notes",
    limit: 4,
    tags: ["public"],
    filters: { email: "owner@example.test" },
  };
  expect(validate(good)).toBe(good);
  for (const bad of [
    {},
    { query: "hello" },
    { query: "hello", limit: "4" },
    { ...good, limit: 0 },
    { ...good, limit: 11 },
    { ...good, limit: 1.5 },
    { ...good, query: "x" },
    { ...good, query: "x".repeat(21) },
    { ...good, query: "HELLO" },
    { ...good, tags: ["unknown"] },
    { ...good, tags: ["public", "public"] },
    { ...good, filters: { email: "invalid" } },
    { ...good, filters: { credential: "invented" } },
    { ...good, endpoint: "https://model-selected.example.test" },
    null,
    [],
    "hello",
  ])
    expect(validate(bad)).toBeUndefined();
});

it("uses JSON Schema 2020-12 by default and supports explicit draft-07", () => {
  const modern = compileMcpArguments({
    type: "object",
    properties: { query: { type: "string" }, scope: { type: "string" } },
    dependentRequired: { scope: ["query"] },
    unevaluatedProperties: false,
  })!;
  expect(modern({ query: "hello" })).toEqual({ query: "hello" });
  expect(modern({ scope: "private" })).toBeUndefined();
  expect(modern({ unknown: true })).toBeUndefined();
  const old = compileMcpArguments({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    definitions: { query: { type: "string", minLength: 3 } },
    properties: { query: { $ref: "#/definitions/query" } },
  })!;
  expect(old({ query: "hello" })).toEqual({ query: "hello" });
  expect(old({ query: "x" })).toBeUndefined();
});

it("supports local references and compound schemas without sharing definitions between tools", () => {
  const validate = compileMcpArguments({
    $id: "https://schemas.example.test/tool",
    type: "object",
    $defs: { name: { type: "string", enum: ["hello", "world"] } },
    properties: { query: { $ref: "#/$defs/name" }, limit: { type: "integer" } },
    oneOf: [{ required: ["query"] }, { required: ["limit"] }],
  })!;
  expect(validate({ query: "hello" })).toEqual({ query: "hello" });
  expect(validate({ query: "other" })).toBeUndefined();
  expect(validate({ query: "hello", limit: 1 })).toBeUndefined();
  expect(
    compileMcpArguments({
      type: "object",
      properties: {
        query: { $ref: "https://schemas.example.test/tool#/$defs/name" },
      },
    }),
  ).toBeUndefined();
});

it("rejects invalid, unsupported, unresolved and asynchronous schemas", () => {
  for (const bad of [
    { type: "array" },
    { type: "object", required: "query" },
    { type: "object", unknownConstraint: true },
    { type: "object", $schema: "https://model-selected.example.test/schema" },
    { type: "object", properties: { query: { $ref: "#/missing" } } },
    {
      type: "object",
      properties: { query: { type: "string", format: "unknown-format" } },
    },
    { type: "object", properties: { query: { type: "string", pattern: "[" } } },
    { type: "object", $async: true },
  ])
    expect(compileMcpArguments(bad)).toBeUndefined();
});

it("does not apply defaults, repair inputs or depend on later schema mutations", () => {
  const pinned = {
    type: "object",
    properties: { limit: { type: "integer", default: 3 } },
    additionalProperties: false,
  };
  const validate = compileMcpArguments(pinned)!;
  const input = {};
  expect(validate(input)).toBe(input);
  expect(input).toEqual({});
  const extra = { other: "keep me" };
  expect(validate(extra)).toBeUndefined();
  expect(extra).toEqual({ other: "keep me" });
  pinned.properties.limit.type = "string";
  expect(validate({ limit: "3" })).toBeUndefined();
  expect(validate({ limit: 3 })).toEqual({ limit: 3 });
  expect(compileMcpArguments(pinned)!({ limit: 3 })).toBeUndefined();
});

it("bounds schemas and arguments and rejects non-JSON data", () => {
  expect(
    compileMcpArguments({ type: "object", description: "x".repeat(16_384) }),
  ).toBeUndefined();
  const validate = compileMcpArguments({ type: "object" })!;
  let deep: Record<string, unknown> = {};
  for (let i = 0; i < 34; i++) deep = { child: deep };
  expect(validate(deep)).toBeUndefined();
  expect(
    compileMcpArguments({ type: "object", default: deep }),
  ).toBeUndefined();
  for (const value of [undefined, NaN, Infinity, () => {}, new Date(), 1n])
    expect(validate({ value })).toBeUndefined();
  expect(validate({ text: "x".repeat(16_384) })).toBeUndefined();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(validate(circular)).toBeUndefined();
});

it("keeps validators usable after bounded cache eviction and isolates repeated schema IDs", () => {
  const first = compileMcpArguments({
    $id: "https://schemas.example.test/shared",
    type: "object",
    required: ["value"],
    properties: { value: { const: "first" } },
  })!;
  for (let i = 0; i < 70; i++) {
    const validate = compileMcpArguments({
      $id: "https://schemas.example.test/shared",
      type: "object",
      required: ["value"],
      properties: { value: { const: i } },
    })!;
    expect(validate({ value: i })).toEqual({ value: i });
    expect(validate({ value: "first" })).toBeUndefined();
  }
  expect(first({ value: "first" })).toEqual({ value: "first" });
  expect(first({ value: 69 })).toBeUndefined();
});
