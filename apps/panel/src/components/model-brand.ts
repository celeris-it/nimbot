import type { ModelReference } from "../../../server/src/providers/usage-contracts.js";
import type { IconName } from "./icons.js";

const modelBrands = new Map<string, IconName>([
  ["deepseek", "deepseek"],
  ["nvidia", "nvidia"],
  ["nemotron", "nvidia"],
  ["xiaomi", "xiaomi"],
  ["mimo", "xiaomi"],
  ["openai", "openai"],
  ["gpt", "openai"],
  ["chatgpt", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["anthropic", "anthropic"],
  ["claude", "anthropic"],
  ["google", "gemini"],
  ["gemini", "gemini"],
  ["mistralai", "mistralai"],
  ["mistral", "mistralai"],
  ["codestral", "mistralai"],
  ["qwen", "qwen"],
  ["meta", "meta"],
  ["meta-llama", "meta"],
  ["llama", "meta"],
  ["minimax", "minimax"],
]);

export function modelIcon(model: ModelReference | null): IconName {
  if (!model) return "settings";
  const segments = model.modelId.toLowerCase().split("/");
  const maker = segments.length > 1 ? segments[0] : undefined;
  const family = segments.at(-1)?.match(/^[a-z]+[0-9]*/)?.[0];
  const familyBrand =
    family &&
    (modelBrands.get(family) ?? modelBrands.get(family.replace(/[0-9]+$/, "")));
  return (
    (maker && modelBrands.get(maker)) ||
    familyBrand ||
    modelBrands.get(model.providerId.toLowerCase()) ||
    "bot"
  );
}
