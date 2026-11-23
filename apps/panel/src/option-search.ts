import type { Translate } from "./i18n/language.js";
import type {
  AgentDirectoryEntry,
  PanelSession,
} from "../../server/src/panel/panel-contracts.js";
import { providers } from "../../server/src/providers/provider-contracts.js";

interface ConfigurationOption {
  label: string;
  context: string;
  href: string;
  keywords: string;
}

export interface ConfigurationGroup {
  key: string;
  label: string;
  options: ConfigurationOption[];
}

export function configurationOptions(
  t: Translate,
  capabilities: PanelSession["capabilities"] | undefined,
  agents: readonly AgentDirectoryEntry[],
): ConfigurationGroup[] {
  if (!capabilities) return [];

  const installation: ConfigurationGroup = {
    key: "installation",
    label: t("Installation"),
    options: [],
  };
  const add = (label: string, context: string, href: string, keywords = "") =>
    installation.options.push({ label, context, href, keywords });

  add(
    t("Appearance"),
    t("Settings"),
    "/settings#panel-appearance",
    t("theme light dark"),
  );
  add(
    t("Language"),
    t("Settings"),
    "/settings#panel-language",
    t("language Spanish English"),
  );
  if (capabilities.scheduleSettings) {
    add(
      t("Schedule time zone"),
      t("Settings"),
      "/settings#schedule-default-zone",
      t("timezone default"),
    );
  }
  if (capabilities.providers) {
    add(
      t("AI providers"),
      "",
      "/providers#ai-providers",
      t("credentials authentication API keys"),
    );
    for (const provider of providers) {
      add(
        provider.name,
        t("AI providers"),
        `/providers#provider-${provider.id}`,
        t("connection credentials API key"),
      );
    }
  }
  if (capabilities.mcp) {
    add(
      t("MCP catalog"),
      "",
      "/mcp#mcp-catalog",
      t("external tools integrations"),
    );
  }

  const groups = [installation];
  const agentNames = new Map<string, number>();
  for (const { name } of agents) {
    const key = name.toLowerCase();
    agentNames.set(key, (agentNames.get(key) ?? 0) + 1);
  }
  const orderedAgents = [...agents].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  for (const agent of orderedAgents) {
    const nameKey = agent.name.toLowerCase();
    const needsIdentifier =
      (agentNames.get(nameKey) ?? 0) > 1 ||
      nameKey === installation.label.toLowerCase();
    const group: ConfigurationGroup = {
      key: `agent:${agent.id}`,
      label: needsIdentifier ? `${agent.name} (${agent.id})` : agent.name,
      options: [],
    };
    const base = `/agents/${encodeURIComponent(agent.id)}`;
    const addAgentOption = (label: string, target: string, keywords = "") =>
      group.options.push({
        label,
        context: "",
        href: `${base}/${target}`,
        keywords,
      });

    if (agent.optionCapabilities?.edit) {
      addAgentOption(
        t("Agent settings"),
        "settings#agent-settings",
        t("name instructions edit"),
      );
    }
    addAgentOption(
      t("Telegram connection"),
      "channels#telegram-connection",
      t("channels bot token owner"),
    );
    if (agent.optionCapabilities?.discord) {
      addAgentOption(
        t("Discord connection"),
        "channels#discord-connection",
        t("channels bot token owner"),
      );
    }
    addAgentOption(
      t("Model"),
      "usage#model-heading",
      t("model selection reasoning effort"),
    );
    addAgentOption(t("Saved notes"), "memory#memory-notes", t("memory"));
    addAgentOption(
      t("Approval rules"),
      "approvals#approval-rules-heading",
      t("permissions allow deny"),
    );
    addAgentOption(
      t("Other agents"),
      "access#peer-access",
      t("peer access grants delegation"),
    );
    if (capabilities.mcp) {
      addAgentOption(
        t("MCP integrations"),
        "access#mcp-access",
        t("access grants credentials"),
      );
    }
    addAgentOption(
      t("Schedules"),
      "schedules#agent-schedules",
      t("cron webhook scheduled tasks"),
    );
    groups.push(group);
  }
  return groups;
}

const searchText = (value: string) =>
  value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

export function matchingOptions(groups: ConfigurationGroup[], query: string) {
  const terms = searchText(query).trim().split(/\s+/);
  if (!terms[0]) return [];
  const phrase = terms.join(" ");
  return groups.flatMap((group) => {
    const options = group.options.filter(({ label, context, keywords }) => {
      const searchable = searchText(
        `${label} ${context} ${keywords} ${group.label}`,
      );
      return terms.every((term) => searchable.includes(term));
    });
    if (!options.length) return [];
    options.sort(
      (a, b) =>
        Number(searchText(b.label).includes(phrase)) -
        Number(searchText(a.label).includes(phrase)),
    );
    return [{ ...group, options }];
  });
}
