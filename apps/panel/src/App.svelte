<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import type {
    AgentDetail,
    DelegationHistory,
    ExecutionDetail,
    ExecutionPage,
    McpAgentDefinition,
    McpCatalogList,
    McpDefinition,
    McpDefinitionSummary,
    McpDiscoveryResult,
    McpExample,
    PanelSession,
    PanelStatus,
    ScheduleList,
    ScheduleDefaults,
    ScheduleSettings,
    Schedule,
    ScheduleRunNowResult,
    ProviderSettings as ProviderSettingsState,
  } from "../../server/src/panel/panel-contracts.js";
  import { ApiError, post, request } from "./api.js";
  import logo from "./nimbot-logo.svg?inline";
  import {
    applyAppearance,
    isAppearance,
    saveAppearance,
    systemAppearance,
    type Appearance,
  } from "./appearance.js";
  import Dashboard from "./Dashboard.svelte";
  import {
    ActionButton,
    Checkbox,
    Icon,
    PasswordField,
    Select,
    TextField,
  } from "./components/index.js";
  import type { IconName } from "./components/icons.js";
  import AgentForm from "./AgentForm.svelte";
  import AgentChannels from "./AgentChannels.svelte";
  import AgentStatus from "./AgentStatus.svelte";
  import AgentHeader from "./AgentHeader.svelte";
  import AgentNavigation from "./AgentNavigation.svelte";
  import ProviderSettings from "./ProviderSettings.svelte";
  import AgentUsageView from "./AgentUsage.svelte";
  import type {
    AgentModels,
    AgentUsage,
    ModelSelection,
  } from "../../server/src/providers/usage-contracts.js";
  import Memory from "./Memory.svelte";
  import Approvals from "./Approvals.svelte";
  import Peers from "./Peers.svelte";
  import Executions from "./Executions.svelte";
  import Delegations from "./Delegations.svelte";
  import McpAgentAccess from "./McpAgentAccess.svelte";
  import McpDefinitionForm from "./McpDefinitionForm.svelte";
  import type { PeerGrant } from "../../server/src/peers/agent-grants.js";
  import type { ApprovalRequest } from "../../server/src/approvals/approval-store.js";
  import type { ApprovalRule } from "../../server/src/approvals/approval-rules.js";
  import type { MemoryEntry } from "../../server/src/memory/host-memories.js";
  import Schedules from "./Schedules.svelte";
  import { scheduleText } from "./labels.js";

  const { initialAppearance }: { initialAppearance: Appearance } = $props();
  let appearance = $state(untrack(() => initialAppearance));
  let path = $state(location.pathname);
  let session = $state<PanelSession>();
  let status = $state<PanelStatus>({ agents: [] });
  let agentQuery = $state("");
  let directoryLoading = $state(false);
  let directoryUnavailable = $state(false);
  let directoryAttempt = $state(0);
  let matchingAgents = $derived.by(() => {
    const query = agentQuery.trim().toLowerCase().replace(/^@/, "");
    return status.agents.filter((item) =>
      `${item.name} ${item.botUsername ?? ""} ${item.id}`
        .toLowerCase()
        .includes(query),
    );
  });
  let agent = $state<AgentDetail>();
  let providerSettings = $state<ProviderSettingsState>();
  let agentModels = $state<AgentModels>();
  let usage = $state<AgentUsage>();
  let usageBefore = $state(usageCursor(location.search));
  let schedules = $state<ScheduleList>();
  let scheduleTimeZone = $state("");
  let memories = $state<{ memories: MemoryEntry[]; hasMore: boolean }>();
  let memoryPage = $state(1);
  let delegations = $state<DelegationHistory>();
  let executionQuery = $state(new URLSearchParams(location.search));
  let executions = $state<ExecutionPage>();
  let executionDetail = $state<ExecutionDetail | null>();
  let delegationPage = $state(delegationPageOf(location.search));
  let mcpDefinitions = $state<McpDefinitionSummary[]>([]);
  let mcpExamples = $state<readonly McpExample[]>([]);
  let mcpExample = $state<McpExample>();
  let mcpExampleId = $state(
    new URLSearchParams(location.search).get("example"),
  );
  let mcpDefinition = $state<McpDefinition>();
  let mcpDiscoveryAgents = $state<{ id: string; name: string }[]>([]);
  let mcpAgentDefinitions = $state<McpAgentDefinition[]>();
  let peers = $state<{
    grants: PeerGrant[];
    candidates: { id: string; name: string }[];
  }>();
  let approvalHistory = $state<{
    requests: ApprovalRequest[];
    hasMore: boolean;
  }>();
  let approvalRules = $state<{ rules: ApprovalRule[]; hasMore: boolean }>();
  let loaded = $state(false);
  let contentAvailable = $state(false);
  let missing = $state(false);
  let busy = $state(false);
  let error = $state("");
  let updateError = $state("");
  let notice = $state("");
  let password = $state("");
  let deleteData = $state(false);
  const labelsKey = "nimbot-panel-nav-labels";
  let compact = $state(false);
  let rail = $state(false);
  let menuOpen = $state(false);
  let navigationExpanded = $state(storedLabels());
  let controller: AbortController | undefined;
  let inFlight = false;
  let route = $derived(
    path.match(
      /^\/agents\/([^/]+)\/(setup|channels|settings|usage|memory|approvals|access|delegations|executions|schedules|token|delete|process\/(?:stop|restart))$/,
    ),
  );
  let mcpRoute = $derived(path.match(/^\/mcp(?:\/([^/]+))?$/));
  let mainLinks = $derived(
    (
      [
        { href: "/", label: "Agents", icon: "grid", available: true },
        {
          href: "/providers",
          label: "AI providers",
          icon: "shield",
          available: session?.capabilities.providers,
        },
        {
          href: "/mcp",
          label: "MCP catalog",
          icon: "plug",
          available: session?.capabilities.mcp,
        },
        {
          href: "/agents/new",
          label: "New agent",
          icon: "plus",
          available: session?.capabilities.createAgent,
        },
        {
          href: "/settings",
          label: "Settings",
          icon: "settings",
          available: session?.capabilities.scheduleSettings,
        },
      ] as const
    ).filter((link) => link.available),
  );
  let desktopSidebar = $derived(rail && session && path !== "/login");
  let pageCard = $derived(!!session && path !== "/login");
  let agentLinks = $derived(
    (
      [
        { view: "setup", label: "Overview", icon: "home" },
        { view: "channels", label: "Channels", icon: "link" },
        { view: "usage", label: "Model and usage", icon: "activity" },
        { view: "memory", label: "Memory", icon: "notebook" },
        { view: "approvals", label: "Approvals", icon: "shield" },
        { view: "access", label: "Access", icon: "key" },
        {
          view: "executions",
          label: "Executions",
          icon: "activity",
          hidden: !session?.capabilities.executions,
        },
        { view: "delegations", label: "Delegations", icon: "delegate" },
        { view: "schedules", label: scheduleText.link, icon: "clock" },
        {
          view: "settings",
          label: "Agent settings",
          icon: "settings",
          hidden: !agent?.capabilities.edit,
        },
      ] satisfies {
        view: string;
        label: string;
        icon: IconName;
        hidden?: boolean;
      }[]
    ).filter((link) => !link.hidden),
  );
  let currentAgent = $derived(
    agent ??
      status.agents.find((item) => encodeURIComponent(item.id) === route?.[1]),
  );
  let switchSection = $derived(
    agentLinks.some(
      (link) => link.view === route?.[2] && link.view !== "settings",
    )
      ? (route?.[2] ?? "setup")
      : "setup",
  );
  $effect(() => {
    if (!session || path === "/" || path === "/login") return;
    // Refresh the agent directory independently of the selected page.
    void directoryAttempt;
    const current = new AbortController();
    directoryLoading = true;
    directoryUnavailable = false;
    void request<PanelStatus>("/api/status", { signal: current.signal })
      .then((data) => {
        if (!current.signal.aborted) status = data;
      })
      .catch((cause: unknown) => {
        if (current.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) expired();
        else directoryUnavailable = true;
      })
      .finally(() => {
        if (!current.signal.aborted) directoryLoading = false;
      });
    return () => current.abort();
  });
  function refreshAgentDirectory() {
    if (path === "/") {
      if (updateError) void load();
    } else if (!directoryLoading) directoryAttempt++;
  }
  let title = $derived(
    path === "/login"
      ? "Sign in"
      : path === "/"
        ? "Agents"
        : path === "/providers"
          ? "AI providers"
          : mcpRoute
            ? "MCP catalog"
            : route?.[2] === "executions"
              ? "Executions"
              : route?.[2] === "channels"
                ? "Channels"
                : route?.[2] === "access"
                  ? "Access"
                  : route?.[2] === "usage"
                    ? "Model and usage"
                    : route?.[2] === "schedules"
                      ? scheduleText.pageTitle
                      : route?.[2] === "delegations"
                        ? "Delegations"
                        : route?.[2] === "approvals"
                          ? "Approvals"
                          : route?.[2] === "memory"
                            ? "Memory"
                            : path === "/agents/new"
                              ? "Create agent"
                              : route?.[2] === "settings"
                                ? "Edit agent"
                                : route?.[2] === "token"
                                  ? "Bot token"
                                  : route?.[2] === "delete"
                                    ? "Delete agent"
                                    : route?.[2] === "process/restart"
                                      ? "Restart agent"
                                      : route?.[2] === "process/stop"
                                        ? "Stop agent"
                                        : "Agent setup",
  );
  let viewLabel = $derived(
    path === "/settings"
      ? "Settings"
      : route?.[2] === "setup"
        ? "Overview"
        : title,
  );

  function storedLabels() {
    try {
      return localStorage.getItem(labelsKey) !== "hidden";
    } catch {
      return true;
    }
  }
  function toggleLabels() {
    navigationExpanded = !navigationExpanded;
    try {
      localStorage.setItem(labelsKey, navigationExpanded ? "shown" : "hidden");
    } catch {
      // Storage can be unavailable; the choice then lasts for this visit only.
    }
  }
  async function focusHeading() {
    await tick();
    document.querySelector<HTMLElement>("h1")?.focus();
  }
  function usageCursor(search: string) {
    const value = Number(new URLSearchParams(search).get("before"));
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  function delegationPageOf(search: string) {
    const page = Number(new URLSearchParams(search).get("page"));
    return Number.isInteger(page) && page >= 1 && page <= 1000 ? page : 1;
  }
  function navigate(next: string, replace = false) {
    controller?.abort();
    controller = undefined;
    inFlight = false;
    if (replace) history.replaceState(null, "", next);
    else history.pushState(null, "", next);
    const url = new URL(next, location.origin);
    path = url.pathname;
    agentQuery = "";
    directoryLoading = false;
    directoryUnavailable = false;
    delegationPage = delegationPageOf(url.search);
    executionQuery = new URLSearchParams(url.search);
    executions = undefined;
    executionDetail = undefined;
    usageBefore = usageCursor(url.search);
    agentModels = undefined;
    usage = undefined;
    delegations = undefined;
    mcpDefinition = undefined;
    mcpExampleId = url.searchParams.get("example");
    mcpExample = undefined;
    mcpExamples = [];
    mcpDiscoveryAgents = [];
    mcpDefinitions = [];
    mcpAgentDefinitions = undefined;
    peers = undefined;
    if (
      !agent ||
      !url.pathname.startsWith(`/agents/${encodeURIComponent(agent.id)}/`)
    )
      agent = undefined;
    providerSettings = undefined;
    schedules = undefined;
    scheduleTimeZone = "";
    loaded = false;
    contentAvailable = false;
    missing = false;
    error = "";
    updateError = "";
    notice = "";
    password = "";
    deleteData = false;
    menuOpen = false;
    void load();
  }
  function expired() {
    session = undefined;
    status = { agents: [] };
    navigate("/login", true);
  }
  async function loadAccessSection<T>(
    url: string,
    signal: AbortSignal,
    update: (data: T | undefined) => void,
  ) {
    try {
      const data = await request<T>(url, { signal });
      if (!signal.aborted) update(data);
    } catch (cause) {
      if (signal.aborted || (cause instanceof ApiError && cause.status === 401))
        throw cause;
      update(undefined);
    }
  }
  async function load(accessSection?: "peers" | "mcp") {
    if (inFlight || path === "/login") {
      if (path === "/login") loaded = true;
      return;
    }
    inFlight = true;
    const current = new AbortController();
    controller = current;
    const initial = !loaded;
    try {
      if (!session)
        session = await request<PanelSession>("/api/session", {
          signal: current.signal,
        });
      if (current.signal.aborted) return;
      if (path === "/")
        status = await request<PanelStatus>("/api/status", {
          signal: current.signal,
        });
      else if (path === "/settings") {
        if (!session.capabilities.scheduleSettings) missing = true;
        else {
          const defaults = await request<ScheduleDefaults>(
            "/api/settings/schedules",
            {
              signal: current.signal,
            },
          );
          if (!current.signal.aborted) scheduleTimeZone = defaults.timeZone;
        }
      } else if (path === "/providers") {
        try {
          providerSettings = await request<ProviderSettingsState>(
            "/api/providers",
            { signal: current.signal },
          );
        } catch (cause) {
          if (
            current.signal.aborted ||
            (cause instanceof ApiError && cause.status === 401)
          )
            throw cause;
          providerSettings = undefined;
        }
      } else if (mcpRoute) {
        const id = mcpRoute[1];
        if (!session.capabilities.mcp) missing = true;
        else if (!id || (id === "new" && mcpExampleId !== null)) {
          const data = await request<McpCatalogList>("/api/mcp", {
            signal: current.signal,
          });
          if (current.signal.aborted) return;
          mcpDefinitions = data.definitions;
          mcpExamples = data.examples;
          if (id === "new") {
            mcpExample = data.examples.find(({ id }) => id === mcpExampleId);
            missing = !mcpExample;
          }
        } else if (id !== "new") {
          const url = `/api/mcp/${id}`;
          const [definition, discovery] = await Promise.all([
            request<McpDefinition>(url, { signal: current.signal }),
            request<{ agents: { id: string; name: string }[] }>(
              `${url}/discovery-agents`,
              { signal: current.signal },
            ),
          ]);
          mcpDefinition = definition;
          mcpDiscoveryAgents = discovery.agents;
        }
      } else if (route) {
        const detail = await request<AgentDetail>(`/api/agents/${route[1]}`, {
          signal: current.signal,
        });
        if (current.signal.aborted) return;
        agent = detail;
        if (route[2] === "usage") {
          const url = `/api/agents/${route[1]}`;
          [agentModels, usage] = await Promise.all([
            request<AgentModels>(`${url}/models`, { signal: current.signal }),
            request<AgentUsage>(
              `${url}/usage${usageBefore ? `?before=${usageBefore}` : ""}`,
              { signal: current.signal },
            ),
          ]);
        }
        if (route[2] === "access") {
          const url = `/api/agents/${route[1]}`;
          await Promise.all([
            accessSection !== "mcp" &&
              loadAccessSection<NonNullable<typeof peers>>(
                `${url}/peers`,
                current.signal,
                (data) => (peers = data),
              ),
            accessSection !== "peers" &&
              session.capabilities.mcp &&
              loadAccessSection<{ definitions: McpAgentDefinition[] }>(
                `${url}/mcp`,
                current.signal,
                (data) => (mcpAgentDefinitions = data?.definitions),
              ),
          ]);
          if (current.signal.aborted) return;
        }
        if (route[2] === "executions") {
          const base = `/api/agents/${route[1]}/executions`;
          const selected = executionQuery.get("task");
          if (selected) {
            try {
              const data = await request<ExecutionDetail>(
                `${base}/${encodeURIComponent(selected)}`,
                { signal: current.signal },
              );
              if (!current.signal.aborted) executionDetail = data;
            } catch (cause) {
              if (!(cause instanceof ApiError) || cause.status !== 404)
                throw cause;
              if (!current.signal.aborted) executionDetail = null;
            }
          } else {
            const before = executionQuery.get("before");
            const query = before ? `?before=${encodeURIComponent(before)}` : "";
            const data = await request<ExecutionPage>(base + query, {
              signal: current.signal,
            });
            if (!current.signal.aborted) executions = data;
          }
          if (current.signal.aborted) return;
        }
        if (route[2] === "delegations") {
          try {
            delegations = await request<DelegationHistory>(
              `/api/agents/${route[1]}/delegations?page=${delegationPage}`,
              { signal: current.signal },
            );
          } catch (cause) {
            if (
              current.signal.aborted ||
              (cause instanceof ApiError && cause.status === 401)
            )
              throw cause;
            delegations = undefined;
          }
        }
        if (route[2] === "approvals") {
          try {
            [approvalHistory, approvalRules] = await Promise.all([
              request<typeof approvalHistory>(
                `/api/agents/${route[1]}/approvals`,
                { signal: current.signal },
              ),
              request<typeof approvalRules>(
                `/api/agents/${route[1]}/approvals/rules`,
                { signal: current.signal },
              ),
            ]);
          } catch (cause) {
            if (
              current.signal.aborted ||
              (cause instanceof ApiError && cause.status === 401)
            )
              throw cause;
            approvalHistory = undefined;
            approvalRules = undefined;
          }
        }
        if (route[2] === "memory") {
          try {
            memories = await request(
              `/api/agents/${route[1]}/memories?page=${memoryPage}`,
              { signal: current.signal },
            );
          } catch (cause) {
            if (
              current.signal.aborted ||
              (cause instanceof ApiError && cause.status === 401)
            )
              throw cause;
            memories = undefined;
          }
        }
        const view = route[2];
        if (view === "schedules")
          schedules = await request<ScheduleList>(
            `/api/agents/${route[1]}/schedules`,
            { signal: current.signal },
          );
        missing =
          (view === "settings" && !agent.capabilities.edit) ||
          (view === "token" && !agent.capabilities.replaceToken) ||
          (view === "delete" && !agent.capabilities.delete) ||
          (view === "process/stop" && !agent.capabilities.process?.stop) ||
          (view === "process/restart" && !agent.capabilities.process?.restart);
      } else
        missing = path !== "/agents/new" || !session.capabilities.createAgent;
      updateError = "";
      contentAvailable = true;
      loaded = true;
      if (initial) void focusHeading();
    } catch (cause) {
      if (current.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 401) {
        expired();
        return;
      }
      if (cause instanceof ApiError && cause.status === 404) {
        missing = true;
        agent = undefined;
      } else {
        updateError = contentAvailable
          ? `Could not update this view (${viewLabel}). Showing the last loaded data.`
          : `Could not load this view (${viewLabel}).`;
      }
      loaded = true;
    } finally {
      if (controller === current) {
        inFlight = false;
        controller = undefined;
      }
    }
  }
  async function mutate<T>(
    url: string,
    fields: Record<string, string> | string,
    done: (result: T) => void,
  ) {
    if (busy) return;
    busy = true;
    error = "";
    notice = "";
    const startedPath = path;
    try {
      const result = await post<T>(url, fields);
      if (path === startedPath) done(result);
    } catch (cause) {
      if (path !== startedPath) return;
      if (
        cause instanceof ApiError &&
        cause.status === 401 &&
        path !== "/login"
      ) {
        expired();
        return;
      }
      if (
        startedPath === "/login" &&
        (!(cause instanceof ApiError) || cause.status >= 500)
      ) {
        const recovered = await request<PanelSession>("/api/session").catch(
          () => undefined,
        );
        if (path !== startedPath) return;
        if (recovered) {
          session = recovered;
          navigate("/");
          return;
        }
        error =
          "Could not confirm sign-in. Check your connection and try signing in again.";
      } else
        error =
          cause instanceof ApiError
            ? cause.message
            : "The result could not be confirmed. Refresh the status before retrying.";
      await tick();
      document.getElementById("form-error")?.focus();
    } finally {
      busy = false;
    }
  }
  async function login(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    const submitted = password;
    password = "";
    await mutate("/api/login", { password: submitted }, () => {
      session = undefined;
      navigate("/");
    });
    if (error) document.getElementById("password")?.focus();
  }
  async function submit(fields: Record<string, string>) {
    if (path === "/agents/new") {
      await mutate<{ agentId: string }>("/api/agents", fields, (result) =>
        navigate(`/agents/${encodeURIComponent(result.agentId)}/setup`),
      );
    } else if (agent && route) {
      const mode = route[2];
      await mutate(
        `/api/agents/${encodeURIComponent(agent.id)}/${mode}`,
        fields,
        () => {
          notice =
            mode === "token"
              ? "Token saved. Restart this agent to reconnect its bot."
              : "Changes saved.";
          if (mode === "settings") {
            directoryAttempt++;
            void load();
          }
        },
      );
    }
  }
  async function connectTelegram(fields: Record<string, string>) {
    if (!agent) return;
    await mutate(
      `/api/agents/${encodeURIComponent(agent.id)}/telegram`,
      fields,
      () => {
        notice = "Telegram connection saved.";
        void load();
      },
    );
  }
  async function discordAction(
    kind: "save" | "remove" | "test",
    fields: Record<string, string>,
  ) {
    if (!agent) return;
    if (kind === "test") {
      await mutate<
        import("../../server/src/notifications/notification-store.js").NotificationRecord
      >(
        `/api/agents/${encodeURIComponent(agent.id)}/discord/test`,
        fields,
        (result) => {
          notice =
            result.status === "delivered"
              ? "Discord test delivered."
              : result.status === "sending"
                ? "Discord test is still sending. Check its status again."
                : result.status === "uncertain"
                  ? "Discord delivery is uncertain. Check your DMs before sending a new test."
                  : result.reason === "rate_limited"
                    ? "Discord test was rate limited. Wait before sending a new test."
                    : result.reason === "rejected"
                      ? "Discord rejected the test. Check your DM settings and whether the bot is blocked."
                      : "Discord test failed. Check the saved connection and DM availability.";
        },
      );
      return;
    }
    await mutate<{ cleanupPending: boolean }>(
      `/api/agents/${encodeURIComponent(agent.id)}/discord${kind === "remove" ? "/remove" : ""}`,
      fields,
      (result) => {
        notice =
          (kind === "remove"
            ? "Discord removed."
            : "Discord connection saved.") +
          (result.cleanupPending
            ? " An unused credential file could not be erased. Check server storage permissions."
            : "");
        void load();
      },
    );
  }
  async function action(kind: "start" | "restart" | "stop" | "delete") {
    if (!agent) return;
    const id = encodeURIComponent(agent.id);
    const target = kind === "delete" ? "delete" : "process";
    await mutate(
      `/api/agents/${id}/${target}`,
      { action: kind, confirm: agent.id, deleteData: String(deleteData) },
      () => {
        if (kind === "delete") navigate("/");
        else if (kind === "stop" || kind === "restart") {
          navigate(`/agents/${id}/setup`);
          notice =
            kind === "restart"
              ? "Agent restarted. Active work may have been interrupted."
              : "Agent stopped. Files and history were kept.";
        } else {
          notice = "Agent started.";
          controller?.abort();
          controller = undefined;
          inFlight = false;
          void load();
        }
      },
    );
  }
  async function saveModel(model: ModelSelection | null) {
    if (!agent) return;
    await mutate<{ selected: ModelSelection | null }>(
      `/api/agents/${encodeURIComponent(agent.id)}/model`,
      JSON.stringify({ model }),
      ({ selected }) => {
        if (agentModels) agentModels = { ...agentModels, selected };
        if (usage) usage = { ...usage, quota: null };
        notice = "Model saved for new turns.";
        void load();
      },
    );
  }
  async function providerAction(
    id: string,
    kind: "save" | "remove" | "login" | "cancel",
    value = "",
  ) {
    const suffix =
      kind === "login"
        ? "/device-login"
        : kind === "cancel"
          ? `/device-login/${encodeURIComponent(value)}/cancel`
          : kind === "remove"
            ? "/remove"
            : "";
    await mutate(
      `/api/providers/${encodeURIComponent(id)}${suffix}`,
      kind === "save" ? { key: value } : {},
      () => {
        notice =
          kind === "save"
            ? "API key saved for all agents."
            : kind === "remove"
              ? "Provider disconnected for all agents."
              : kind === "cancel"
                ? "Login status updated."
                : "Device login started. Complete authorization using the link below.";
        void load();
      },
    );
  }

  async function saveMcp(
    settings: Pick<
      McpDefinition,
      "label" | "endpoint" | "enabled" | "tools"
    > & { reviewedTools: string[] },
  ) {
    if (mcpDefinition) {
      await mutate<{ definition: McpDefinition; cleanupPending: boolean }>(
        `/api/mcp/${encodeURIComponent(mcpDefinition.id)}`,
        JSON.stringify({ ...settings, revision: mcpDefinition.revision }),
        (result) => {
          mcpDefinition = result.definition;
          controller?.abort();
          inFlight = false;
          void load();
          notice = result.cleanupPending
            ? "Integration saved. Credential cleanup is pending."
            : "Integration saved.";
        },
      );
    } else {
      await mutate<McpDefinition>(
        "/api/mcp",
        JSON.stringify(settings),
        (result) => {
          navigate(`/mcp/${encodeURIComponent(result.id)}`, true);
          notice = "Integration saved.";
        },
      );
    }
  }
  async function discoverMcp(agentId?: string) {
    if (!mcpDefinition || busy) return undefined;
    let result: McpDiscoveryResult | undefined;
    await mutate<McpDiscoveryResult>(
      `/api/mcp/${encodeURIComponent(mcpDefinition.id)}/discover`,
      JSON.stringify({ revision: mcpDefinition.revision, agentId }),
      (value) => {
        result = value;
      },
    );
    return result;
  }
  async function discoverMcpExample(id: string, signal: AbortSignal) {
    try {
      return await request<McpDiscoveryResult>(
        `/api/mcp/examples/${encodeURIComponent(id)}/discover`,
        { method: "POST", signal },
      );
    } catch (cause) {
      if (signal.aborted) return undefined;
      if (cause instanceof ApiError && cause.status === 401) {
        expired();
        return undefined;
      }
      return { status: "unavailable" } as const;
    }
  }
  async function mcpAgentAction(
    definition: McpAgentDefinition,
    command: "grant" | "revoke" | "credential",
    token?: string | null,
  ) {
    if (!agent) return;
    const startedPath = path;
    await mutate<{ cleanupPending?: boolean }>(
      `/api/agents/${encodeURIComponent(agent.id)}/mcp/${encodeURIComponent(definition.id)}/${command}`,
      JSON.stringify({ revision: definition.revision, token }),
      (result) => {
        notice = result.cleanupPending
          ? "MCP access updated. Credential cleanup is pending."
          : "MCP access updated.";
      },
    );
    if (path === startedPath && session) {
      controller?.abort();
      inFlight = false;
      void load("mcp");
    }
  }
  async function cancelDelegation(id: string) {
    if (!agent || busy) return;
    const startedPath = path;
    await mutate(
      `/api/agents/${encodeURIComponent(agent.id)}/delegations/${encodeURIComponent(id)}/cancel`,
      {},
      () => {
        notice = "Cancellation requested.";
      },
    );
    if (path === startedPath && session) {
      controller?.abort();
      inFlight = false;
      void load();
    }
  }
  async function peerAction(
    kind: "grant" | "revoke",
    target: string,
    permission: string,
  ): Promise<boolean> {
    if (!agent) return false;
    let done = false;
    await mutate(
      `/api/agents/${encodeURIComponent(agent.id)}/peers/${kind}`,
      { target, permission },
      () => {
        done = true;
        notice = kind === "grant" ? "Grant added." : "Grant revoked.";
        controller?.abort();
        inFlight = false;
        void load("peers");
      },
    );
    return done;
  }
  async function createApprovalRule(
    fields: Record<string, string>,
  ): Promise<boolean> {
    if (!agent) return false;
    let saved = false;
    await mutate(
      `/api/agents/${encodeURIComponent(agent.id)}/approvals/rules`,
      fields,
      () => {
        saved = true;
        notice = "Rule added.";
        void load();
      },
    );
    return saved;
  }
  async function revokeApprovalRule(id: string) {
    if (!agent) return;
    await mutate(
      `/api/agents/${encodeURIComponent(agent.id)}/approvals/rules/${encodeURIComponent(id)}/revoke`,
      {},
      () => {
        notice = "Rule revoked.";
        void load();
      },
    );
  }
  async function setMemoryEnabled(enabled: boolean) {
    if (!agent) return;
    await mutate(
      `/api/agents/${encodeURIComponent(agent.id)}/memory-access`,
      { enabled: String(enabled) },
      () => {
        notice = enabled
          ? "Memory tools turned on for this agent's chat tasks."
          : "Memory tools turned off.";
        void load();
      },
    );
  }
  async function deleteMemory(id: string) {
    if (!agent) return;
    await mutate(
      `/api/agents/${encodeURIComponent(agent.id)}/memories/${encodeURIComponent(id)}/delete`,
      {},
      () => {
        notice = "Note deleted.";
        void load();
      },
    );
  }
  async function saveSchedule(
    settings: ScheduleSettings,
    id?: string,
  ): Promise<boolean> {
    if (!agent) return false;
    let saved = false;
    await mutate(
      `/api/agents/${encodeURIComponent(agent.id)}/schedules${id ? `/${encodeURIComponent(id)}` : ""}`,
      { ...settings, cadence: JSON.stringify(settings.cadence) },
      () => {
        saved = true;
        notice = scheduleText.saved;
        void load();
      },
    );
    return saved;
  }
  async function scheduleAction(
    id: string,
    kind: "pause" | "resume" | "run" | "remove",
  ): Promise<boolean> {
    if (!agent) return false;
    let saved = false;
    await mutate<
      ScheduleRunNowResult | { schedule: Schedule } | { removed: boolean }
    >(
      `/api/agents/${encodeURIComponent(agent.id)}/schedules/${encodeURIComponent(id)}/${kind}`,
      {},
      (result) => {
        saved = true;
        notice =
          "outcome" in result
            ? scheduleText.outcomes[
                result.outcome as keyof typeof scheduleText.outcomes
              ]
            : kind === "remove"
              ? scheduleText.removed
              : kind === "pause"
                ? scheduleText.pauseDone
                : "schedule" in result && !result.schedule.enabled
                  ? scheduleText.expired
                  : scheduleText.resumeDone;
        void load();
      },
    );
    return saved;
  }
  function click(event: MouseEvent) {
    if (event.defaultPrevented) return;
    const link =
      event.target instanceof Element ? event.target.closest("a") : null;
    if (
      !link ||
      link.target ||
      link.hasAttribute("download") ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || url.hash) return;
    event.preventDefault();
    if (!busy) navigate(url.pathname + url.search);
  }
  onMount(() => {
    const compactWidth = window.matchMedia("(width < 600px)");
    const railWidth = window.matchMedia("(width >= 840px)");
    const syncNavigation = () => {
      compact = compactWidth.matches;
      rail = railWidth.matches;
      if (!compact) menuOpen = false;
    };
    syncNavigation();
    compactWidth.addEventListener("change", syncNavigation);
    railWidth.addEventListener("change", syncNavigation);
    const syncAppearance = () => {
      if (appearance === "system") applyAppearance(appearance);
    };
    systemAppearance.addEventListener("change", syncAppearance);
    syncAppearance();
    document.addEventListener("click", click);
    const pop = () => navigate(location.pathname + location.search, true);
    const visible = () => {
      if (document.hidden) {
        controller?.abort();
        controller = undefined;
        inFlight = false;
      } else void load();
    };
    window.addEventListener("popstate", pop);
    document.addEventListener("visibilitychange", visible);
    const timer = setInterval(() => {
      if (
        !document.hidden &&
        !busy &&
        (path === "/" ||
          route?.[2] === "setup" ||
          route?.[2] === "channels" ||
          route?.[2] === "schedules" ||
          route?.[2] === "executions" ||
          route?.[2] === "usage")
      )
        void load();
    }, 5000);
    void load();
    return () => {
      clearInterval(timer);
      compactWidth.removeEventListener("change", syncNavigation);
      railWidth.removeEventListener("change", syncNavigation);
      systemAppearance.removeEventListener("change", syncAppearance);
      controller?.abort();
      document.removeEventListener("click", click);
      window.removeEventListener("popstate", pop);
      document.removeEventListener("visibilitychange", visible);
    };
  });
</script>

<svelte:head>
  <title>{path === "/settings" ? "Settings" : title} · Nimbot</title>
  <link rel="icon" type="image/svg+xml" href={logo} />
</svelte:head>
<a id="skip" href="#main">Skip to main content</a>
{#snippet wordmark()}
  <a href="/" data-ui="wordmark" aria-label="Nimbot home">
    <img src={logo} alt="" width="30" height="30" />
    <span data-ui="wordmark-text"
      >nimbot<span data-ui="wordmark-dot">.</span></span
    >
  </a>
{/snippet}
{#snippet mainNavLink(link: (typeof mainLinks)[number])}
  <li>
    <a
      href={link.href}
      aria-label={link.label}
      aria-current={path === link.href
        ? "page"
        : (link.href === "/" && route) || (link.href === "/mcp" && mcpRoute)
          ? "location"
          : undefined}
    >
      <Icon name={link.icon} />
      <span aria-hidden="true" data-ui="navigation-label">{link.label}</span>
    </a>
  </li>
{/snippet}
{#snippet signOut(inSidebar: boolean)}
  <ActionButton
    variant="ghost"
    type="button"
    aria-label="Sign out"
    disabled={busy}
    onclick={() => mutate("/api/logout", {}, expired)}
  >
    <Icon name="logout" size={inSidebar ? 18 : 16} />
    <span
      aria-hidden="true"
      data-ui={inSidebar ? "navigation-label" : undefined}
    >
      Sign out
    </span>
  </ActionButton>
{/snippet}
{#snippet agentDirectory()}
  {#key path}
    <AgentHeader
      agents={status.agents}
      matches={matchingAgents}
      current={currentAgent}
      section={switchSection}
      loading={path === "/" ? !loaded : directoryLoading}
      unavailable={path === "/" ? !!updateError : directoryUnavailable}
      refresh={refreshAgentDirectory}
      bind:query={agentQuery}
    />
  {/key}
{/snippet}
{#if !desktopSidebar}
  <header>
    {@render wordmark()}
    {#if pageCard}
      <div data-ui="header-actions">
        {#if compact}<ActionButton
            variant="ghost"
            type="button"
            aria-expanded={menuOpen}
            aria-controls="main-navigation-links"
            onclick={() => (menuOpen = !menuOpen)}
            ><Icon
              name={menuOpen ? "collapsePanel" : "expandPanel"}
              size={16}
            /> Menu</ActionButton
          >{/if}
        {@render signOut(false)}
      </div>
    {:else}<span data-ui="installation"
        ><Icon name="shield" size={15} /> SELF-HOSTED & PRIVATE</span
      >{/if}
  </header>
{/if}
<div data-ui="panel-shell">
  {#if session && path !== "/login" && (!compact || menuOpen)}
    <nav
      aria-label="Main navigation"
      data-ui="main-navigation"
      data-expanded={!rail || navigationExpanded}
    >
      {#if desktopSidebar}
        {@render wordmark()}
        <ActionButton
          variant="ghost"
          type="button"
          aria-label={navigationExpanded ? "Hide labels" : "Show labels"}
          aria-expanded={navigationExpanded}
          aria-controls="main-navigation-links"
          onclick={toggleLabels}
        >
          <Icon name={navigationExpanded ? "collapsePanel" : "expandPanel"} />
          {#if navigationExpanded}<span>Hide labels</span>{/if}
        </ActionButton>{/if}
      <div id="main-navigation-links">
        <ul class="panel-menu">
          {#each mainLinks as link (link.href)}
            {#if !desktopSidebar || link.href !== "/settings"}
              {@render mainNavLink(link)}
            {/if}
          {/each}
        </ul>
        {#if desktopSidebar}
          {@const settings = mainLinks.find(
            (link) => link.href === "/settings",
          )}
          <div data-ui="sidebar-actions">
            {#if settings}
              <ul class="panel-menu">
                {@render mainNavLink(settings)}
              </ul>
            {/if}
            {@render signOut(true)}
          </div>
        {/if}
      </div>
    </nav>
  {/if}
  <div data-ui="page-layout" data-page-card={pageCard ? "" : undefined}>
    {#if pageCard}{@render agentDirectory()}{/if}
    {#if !missing && agent && route}
      {#key path}<AgentNavigation
          links={agentLinks}
          agentId={agent.id}
          currentView={route[2] === "token" ? "channels" : route[2]}
        />{/key}
    {/if}
    <main
      id="main"
      tabindex="-1"
      data-page={path === "/login"
        ? "login"
        : path === "/"
          ? "dashboard"
          : "detail"}
    >
      {#if path !== "/login"}<p id="form-error" role="alert" tabindex="-1">
          {error}
        </p>{/if}
      {#if notice}<p role="status">{notice}</p>{/if}
      {#if updateError}<p role="status">{updateError}</p>
        <ActionButton onclick={() => load()}
          >Retry loading {viewLabel}</ActionButton
        >{/if}
      {#if path === "/login"}
        <section aria-label="Sign in">
          <small>ADMINISTRATION</small>
          <h1 tabindex="-1">Your agent workspace.</h1>
          <p>Sign in to check the status of your installation.</p>
          <div class="panel-card">
            <form
              onsubmit={login}
              aria-describedby="form-error"
              aria-busy={busy}
            >
              <label for="password">Administrator password</label>
              <PasswordField
                aria-invalid={error ? "true" : undefined}
                id="password"
                name="password"
                autocomplete="current-password"
                required
                maxlength={256}
                aria-describedby="password-help form-error"
                bind:value={password}
              />
              <p id="password-help">
                Use the password configured on your server.
              </p>
              <p id="form-error" role="alert" tabindex="-1">{error}</p>
              <ActionButton variant="primary" type="submit" disabled={busy}
                >{busy ? "Signing in…" : "Sign in to the panel"}</ActionButton
              >
            </form>
          </div>
        </section>
      {:else if !loaded}<p role="status">Loading…</p>
      {:else if missing}<h1 tabindex="-1">Page not found.</h1>
        <p>This agent or action is no longer available.</p>
        <ActionButton href="/">All agents</ActionButton>
      {:else if !contentAvailable}
        <h1 tabindex="-1">Status unavailable.</h1>
        <ActionButton href="/">All agents</ActionButton>
      {:else if path === "/"}
        <Dashboard
          agents={status.agents}
          {matchingAgents}
          clearSearch={() => (agentQuery = "")}
          canCreate={session?.capabilities.createAgent ?? false}
          refresh={() => load()}
        />
      {:else if path === "/settings"}
        <h1 tabindex="-1">Settings</h1>
        <div class="panel-card">
          <label for="panel-appearance">Appearance</label>
          <Select
            id="panel-appearance"
            value={appearance}
            onchange={(event) => {
              const value = event.currentTarget.value;
              if (isAppearance(value)) {
                appearance = value;
                saveAppearance(value);
              }
            }}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </Select>
        </div>
        <form
          class="panel-card"
          aria-busy={busy}
          aria-describedby="form-error"
          onsubmit={(event) => {
            event.preventDefault();
            void mutate<ScheduleDefaults>(
              "/api/settings/schedules",
              { timeZone: scheduleTimeZone },
              (result) => {
                scheduleTimeZone = result.timeZone;
                notice = "Schedule time zone saved.";
              },
            );
          }}
        >
          <label for="schedule-default-zone">Schedule time zone</label>
          <TextField
            id="schedule-default-zone"
            aria-describedby="schedule-default-zone-help"
            bind:value={scheduleTimeZone}
            required
            disabled={busy}
            spellcheck="false"
            placeholder="America/New_York"
          />
          <p id="schedule-default-zone-help">
            Use an IANA time zone such as America/New_York or UTC. It applies to
            new schedules in Telegram and prefills the schedule form in the
            panel.
          </p>
          <ActionButton type="submit" variant="primary" disabled={busy}
            >Save settings</ActionButton
          >
        </form>
      {:else if path === "/providers"}
        <ProviderSettings
          settings={providerSettings}
          {busy}
          action={providerAction}
          refresh={() => load()}
        />
      {:else if path === "/agents/new"}
        {#key path}<AgentForm mode="new" {busy} {submit} />{/key}
      {:else if path === "/mcp"}
        <h1 tabindex="-1">MCP catalog</h1>
        <ActionButton variant="primary" href="/mcp/new"
          >Add integration</ActionButton
        >
        {#if mcpDefinitions.length === 0}
          <p>No integrations in the catalog.</p>
        {:else}
          <section class="panel-card" aria-label="Integrations">
            <ul>
              {#each mcpDefinitions as definition (definition.id)}
                <li>
                  <a href={`/mcp/${encodeURIComponent(definition.id)}`}
                    >{definition.label}</a
                  >
                  · {definition.enabled ? "Enabled" : "Disabled"}
                  {#if definition.blockedTools?.length}<span class="panel-badge"
                      >Review needed</span
                    >{/if}
                </li>
              {/each}
            </ul>
          </section>
        {/if}
        <section class="grid gap-4" aria-labelledby="mcp-examples-heading">
          <h2 id="mcp-examples-heading">Examples</h2>
          <ul class="grid gap-4 sm:grid-cols-3">
            {#each mcpExamples as example (example.id)}
              <li class="panel-card">
                <h3>{example.label}</h3>
                <p class="grow">{example.description}</p>
                <ActionButton
                  class="self-start"
                  href={`/mcp/new?example=${encodeURIComponent(example.id)}`}
                  aria-label={`Set up ${example.label}`}>Set up</ActionButton
                >
              </li>
            {/each}
          </ul>
        </section>
      {:else if mcpRoute}
        <h1 tabindex="-1">
          {mcpDefinition
            ? `Edit ${mcpDefinition.label}`
            : mcpExample
              ? `Set up ${mcpExample.label}`
              : "Add MCP integration"}
        </h1>
        <ActionButton href="/mcp">Back to catalog</ActionButton>
        {#key path + (mcpDefinition?.revision ?? mcpExample?.id ?? "")}
          <McpDefinitionForm
            definition={mcpDefinition}
            example={mcpExample}
            {busy}
            save={saveMcp}
            discoveryAgents={mcpDiscoveryAgents}
            discover={discoverMcp}
            discoverExample={discoverMcpExample}
          />
        {/key}
      {:else if agent && route}
        {#if route[2] === "schedules" && schedules}
          {#key agent.id}<Schedules
              {agent}
              data={schedules}
              {busy}
              save={saveSchedule}
              action={scheduleAction}
              refresh={() => load()}
            />{/key}
        {:else if route[2] === "access"}
          <h1 tabindex="-1">Access for {agent.name}</h1>
          {#key agent.id}
            <div class="settings-section-list">
              <Peers
                {agent}
                data={peers}
                {busy}
                refresh={() => load("peers")}
                grant={(target, permission) =>
                  peerAction("grant", target, permission)}
                revoke={async (target, permission) => {
                  await peerAction("revoke", target, permission);
                }}
              />
              {#if session?.capabilities.mcp}
                <McpAgentAccess
                  {busy}
                  definitions={mcpAgentDefinitions}
                  refresh={() => load("mcp")}
                  action={mcpAgentAction}
                />
              {/if}
            </div>
          {/key}
        {:else if route[2] === "executions"}
          <Executions
            agentId={agent.id}
            data={executions}
            detail={executionDetail}
            before={executionQuery.get("before")}
            selected={executionQuery.get("task")}
          />
        {:else if route[2] === "delegations"}
          <Delegations
            {agent}
            data={delegations}
            page={delegationPage}
            {busy}
            cancel={cancelDelegation}
            refresh={() => load()}
          />
        {:else if route[2] === "approvals"}
          {#key agent.id}<Approvals
              {agent}
              history={approvalHistory}
              rules={approvalRules}
              {busy}
              createRule={createApprovalRule}
              revokeRule={revokeApprovalRule}
            />{/key}
        {:else if route[2] === "memory"}
          {#key agent.id}<Memory
              {agent}
              {memories}
              page={memoryPage}
              {busy}
              remove={deleteMemory}
              enabled={agent.memoryEnabled}
              setEnabled={setMemoryEnabled}
              go={(next) => {
                memoryPage = next;
                void load();
              }}
            />{/key}
        {:else if route[2] === "usage"}
          {#key agent.id}<AgentUsageView
              {agent}
              catalog={agentModels}
              data={usage}
              before={usageBefore}
              {busy}
              save={saveModel}
              refresh={load}
            />{/key}
        {:else if route[2] === "setup"}
          {#key agent.id}<AgentStatus
              {agent}
              {busy}
              {action}
              refresh={() => load()}
            />{/key}
        {:else if route[2] === "channels"}
          {#key agent.id}<AgentChannels
              {agent}
              {busy}
              {discordAction}
              {connectTelegram}
              refresh={() => load()}
            />{/key}
        {:else if route[2] === "settings" || route[2] === "token"}
          {#key path}<AgentForm mode={route[2]} {agent} {busy} {submit} />{/key}
        {:else if route[2] === "process/stop" || route[2] === "process/restart"}
          <h1 tabindex="-1">
            {route[2] === "process/restart" ? "Restart" : "Stop"}
            {agent.name}?
          </h1>
          <p>
            The Agent Host process will be {route[2] === "process/restart"
              ? "stopped and started again"
              : "stopped"}. Active work may be interrupted. Files and
            conversation history are kept.
          </p>
          <div class="button-row">
            <ActionButton
              variant={route[2] === "process/restart" ? "primary" : "danger"}
              disabled={busy}
              onclick={() =>
                action(route?.[2] === "process/restart" ? "restart" : "stop")}
              >{busy
                ? "Working…"
                : route[2] === "process/restart"
                  ? "Confirm restart"
                  : "Confirm stop"}</ActionButton
            >
            <ActionButton
              variant="ghost"
              href={`/agents/${encodeURIComponent(agent.id)}/setup`}
              >Cancel</ActionButton
            >
          </div>
        {:else if route[2] === "delete"}
          <h1 tabindex="-1">Delete {agent.name}?</h1>
          <p>
            Its Agent Host will stop. Agent data is kept unless you explicitly
            delete it below.
          </p>
          {#if agent.botUsername}
            <p>
              Local Telegram credentials and the chat binding will be erased.
              The Telegram bot can be revoked separately in BotFather.
            </p>
          {/if}
          <form
            onsubmit={(event) => {
              event.preventDefault();
              void action("delete");
            }}
            aria-describedby="form-error"
            aria-busy={busy}
          >
            <Checkbox bind:checked={deleteData}
              >Also permanently delete the agent data directory and AI
              conversation history, including its workspace, task history and
              browser profile.</Checkbox
            >
            <div class="button-row">
              <ActionButton variant="danger" type="submit" disabled={busy}
                >{busy
                  ? "Deleting…"
                  : deleteData
                    ? "Delete agent and its data"
                    : "Delete agent, keep its data"}</ActionButton
              ><ActionButton
                variant="ghost"
                href={`/agents/${encodeURIComponent(agent.id)}/setup`}
                >Cancel</ActionButton
              >
            </div>
          </form>
        {/if}
      {/if}
    </main>
  </div>
</div>
