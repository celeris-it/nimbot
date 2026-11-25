import type { McpActivationResult } from "../../server/src/panel/panel-contracts.js";
import type { Translate } from "./i18n/language.js";

export function mcpActivationMessage(
  t: Translate,
  result: McpActivationResult,
) {
  switch (result.status) {
    case "connected": {
      const enabled = result.added
        ? t("Enabled {0} new MCP tools.", result.added)
        : t("No new compatible MCP tools were found.");
      return result.omitted.length
        ? `${enabled} ${t("Skipped incompatible tools ({0}).", result.omitted.join(", "))}`
        : enabled;
    }
    case "unauthorized":
      return t(
        "The endpoint rejected the connection. Save a valid shared credential and retry tool setup.",
      );
    case "timeout":
      return t(
        "Tool discovery timed out. Retry from the integration settings.",
      );
    case "redirect":
      return t(
        "Tool discovery stopped because the endpoint attempted to redirect.",
      );
    case "pagination_limit":
      return t("The MCP endpoint exceeded the four-page tool listing limit.");
    case "response_too_large":
      return t(
        "The MCP response exceeded Nimbot’s 256 KiB limit. If the provider offers a smaller toolset, use its endpoint.",
      );
    case "catalog_limit":
      return t(
        "The tools exceed the catalog storage limit. Try a smaller toolset.",
      );
    case "unavailable":
      return t("Tool discovery failed. Retry from the integration settings.");
  }
}
