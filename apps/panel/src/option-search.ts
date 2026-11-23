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
  capabilities: PanelSession["capabilities"] | undefined,
  agents: readonly AgentDirectoryEntry[],
): ConfigurationGroup[] {
  if (!capabilities) return [];

  const installation: ConfigurationGroup = {
    key: "installation",
    label: "Installation",
    options: [],
  };
  const add = (label: string, context: string, href: string, keywords = "") =>
    installation.options.push({ label, context, href, keywords });

  if (capabilities.scheduleSettings) {
    add(
      "Appearance",
      "Settings",
      "/settings#panel-appearance",
      "theme light dark",
    );
    add(
      "Schedule time zone",
      "Settings",
      "/settings#schedule-default-zone",
      "timezone default",
    );
  }
  if (capabilities.providers) {
    add(
      "AI providers",
      "",
      "/providers#ai-providers",
      "credentials authentication API keys",
    );
    for (const provider of providers) {
      add(
        provider.name,
        "AI providers",
        `/providers#provider-${provider.id}`,
        "connection credentials API key",
      );
    }
  }
  if (capabilities.mcp) {
    add("MCP catalog", "", "/mcp#mcp-catalog", "external tools integrations");
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
        "Agent settings",
        "settings#agent-settings",
        "name instructions edit",
      );
    }
    addAgentOption(
      "Telegram connection",
      "channels#telegram-connection",
      "channels bot token owner",
    );
    if (agent.optionCapabilities?.discord) {
      addAgentOption(
        "Discord connection",
        "channels#discord-connection",
        "channels bot token owner",
      );
    }
    addAgentOption(
      "Model",
      "usage#model-heading",
      "model selection reasoning effort",
    );
    if (agent.optionCapabilities?.memoryTools) {
      addAgentOption(
        "Memory tools",
        "memory#memory-tools",
        "notes enable disable",
      );
    }
    addAgentOption(
      "Approval rules",
      "approvals#approval-rules-heading",
      "permissions allow deny",
    );
    addAgentOption(
      "Other agents",
      "access#peer-access",
      "peer access grants delegation",
    );
    if (capabilities.mcp) {
      addAgentOption(
        "MCP integrations",
        "access#mcp-access",
        "access grants credentials",
      );
    }
    addAgentOption(
      "Schedules",
      "schedules#agent-schedules",
      "cron webhook scheduled tasks",
    );
    groups.push(group);
  }
  return groups;
}

export function matchingOptions(groups: ConfigurationGroup[], query: string) {
  const terms = query.toLowerCase().trim().split(/\s+/);
  if (!terms[0]) return [];
  const phrase = terms.join(" ");
  return groups.flatMap((group) => {
    const options = group.options.filter(({ label, context, keywords }) => {
      const searchable =
        `${label} ${context} ${keywords} ${group.label}`.toLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
    if (!options.length) return [];
    options.sort(
      (a, b) =>
        Number(b.label.toLowerCase().includes(phrase)) -
        Number(a.label.toLowerCase().includes(phrase)),
    );
    return [{ ...group, options }];
  });
}
