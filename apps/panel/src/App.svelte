<script lang="ts">
  import {
    clearFieldValidation,
    localizeInvalidField,
  } from "./i18n/validation.js";
  import LanguageSelect from "./components/LanguageSelect.svelte";
  import { messages, translateDescription } from "./i18n/language.js";
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
  import { configurationOptions } from "./option-search.js";
  import AgentNavigation from "./AgentNavigation.svelte";
  import Rules from "./Rules.svelte";
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
  import { scheduleText as getScheduleText } from "./labels.js";
  const scheduleText = $derived(getScheduleText($messages));

  const { initialAppearance }: { initialAppearance: Appearance } = $props();
  let appearance = $state(untrack(() => initialAppearance));
  let path = $state(location.pathname);
  let pageSearch = location.search;
  let session = $state<PanelSession>();
  let status = $state<PanelStatus>({ agents: [] });
  let optionQuery = $state("");
  let directoryLoading = $state(false);
  let directoryUnavailable = $state(false);
  let directoryAttempt = $state(0);
  let agent = $state<AgentDetail>();
  let providerSettings = $state<ProviderSettingsState>();
  let providerSettingsErrorMessage = $state<() => string>();
  const providerSettingsError = $derived(
    providerSettingsErrorMessage?.() ?? "",
  );
  let agentModels = $state<AgentModels>();
  let usage = $state<AgentUsage>();
  let usageBefore = $state(usageCursor(location.search));
  let schedules = $state<ScheduleList>();
  let scheduleTimeZone = $state("");
  let scheduleTimeZoneErrorMessage = $state<() => string>();
  const scheduleTimeZoneError = $derived(
    scheduleTimeZoneErrorMessage?.() ?? "",
  );
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
  let options = $derived(
    configurationOptions($messages, session?.capabilities, status.agents),
  );
  let busy = $state(false);
  let errorMessage = $state<() => string>();
  const error = $derived(errorMessage?.() ?? "");
  let updateErrorMessage = $state<() => string>();
  const updateError = $derived(updateErrorMessage?.() ?? "");
  let noticeMessage = $state<() => string>();
  const notice = $derived(noticeMessage?.() ?? "");
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
      /^\/agents\/([^/]+)\/(setup|channels|settings|rules|usage|memory|approvals|access|delegations|executions|schedules|token|delete|process\/(?:stop|restart))$/,
    ),
  );
  let mcpRoute = $derived(path.match(/^\/mcp(?:\/([^/]+))?$/));
  let mainLinks = $derived(
    (
      [
        {
          href: "/",
          label: $messages("Agents"),
          icon: "grid",
          available: true,
        },
        {
          href: "/providers",
          label: $messages("AI providers"),
          icon: "shield",
          available: session?.capabilities.providers,
        },
        {
          href: "/mcp",
          label: $messages("MCP catalog"),
          icon: "plug",
          available: session?.capabilities.mcp,
        },
        {
          href: "/rules",
          label: $messages("Rules"),
          icon: "check",
          available: session?.capabilities.rules,
        },
        {
          href: "/agents/new",
          label: $messages("New agent"),
          icon: "plus",
          available: session?.capabilities.createAgent,
        },
        {
          href: "/settings",
          label: $messages("Settings"),
          icon: "settings",
          available: true,
        },
      ] as const
    ).filter((link) => link.available),
  );
  let desktopSidebar = $derived(rail && session && path !== "/login");
  let pageCard = $derived(!!session && path !== "/login");
  let agentLinks = $derived(
    (
      [
        { view: "setup", label: $messages("Overview"), icon: "home" },
        { view: "channels", label: $messages("Channels"), icon: "link" },
        {
          view: "usage",
          label: $messages("Model and usage"),
          icon: "activity",
        },
        {
          view: "rules",
          label: $messages("Rules"),
          icon: "check",
          hidden: !session?.capabilities.rules,
        },
        { view: "memory", label: $messages("Memory"), icon: "notebook" },
        { view: "approvals", label: $messages("Approvals"), icon: "shield" },
        { view: "access", label: $messages("Access"), icon: "key" },
        {
          view: "executions",
          label: $messages("Executions"),
          icon: "activity",
          hidden: !session?.capabilities.executions,
        },
        {
          view: "delegations",
          label: $messages("Delegations"),
          icon: "delegate",
        },
        { view: "schedules", label: scheduleText.link, icon: "clock" },
        {
          view: "settings",
          label: $messages("Agent settings"),
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
      ? $messages("Sign in")
      : path === "/"
        ? $messages("Agents")
        : path === "/providers"
          ? $messages("AI providers")
          : mcpRoute
            ? $messages("MCP catalog")
            : route?.[2] === "executions"
              ? $messages("Executions")
              : route?.[2] === "channels"
                ? $messages("Channels")
                : route?.[2] === "access"
                  ? $messages("Access")
                  : route?.[2] === "usage"
                    ? $messages("Model and usage")
                    : route?.[2] === "schedules"
                      ? scheduleText.pageTitle
                      : route?.[2] === "delegations"
                        ? $messages("Delegations")
                        : route?.[2] === "approvals"
                          ? $messages("Approvals")
                          : route?.[2] === "memory"
                            ? $messages("Memory")
                            : path === "/agents/new"
                              ? $messages("Create agent")
                              : route?.[2] === "settings"
                                ? $messages("Edit agent")
                                : route?.[2] === "token"
                                  ? $messages("Bot token")
                                  : route?.[2] === "delete"
                                    ? $messages("Delete agent")
                                    : route?.[2] === "process/restart"
                                      ? $messages("Restart agent")
                                      : route?.[2] === "process/stop"
                                        ? $messages("Stop agent")
                                        : path === "/rules" ||
                                            route?.[2] === "rules"
                                          ? $messages("Rules")
                                          : $messages("Agent setup"),
  );
  let viewLabel = $derived(
    path === "/settings"
      ? $messages("Settings")
      : route?.[2] === "setup"
        ? $messages("Overview")
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
  async function focusDestination(
    fallback = true,
    previousFocus = document.activeElement,
  ) {
    const url = location.href;
    await tick();
    if (location.href !== url) return;
    if (
      document.activeElement !== previousFocus &&
      document.activeElement !== document.body
    )
      return;
    const main = document.getElementById("main");
    if (!main) return;
    const target = document.getElementById(location.hash.slice(1));
    if (target && target !== main && main.contains(target)) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "center" });
    } else if (fallback) {
      main.querySelector("h1")?.focus();
    }
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
    pageSearch = url.search;
    optionQuery = "";
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
    providerSettingsErrorMessage = undefined;
    schedules = undefined;
    scheduleTimeZone = "";
    scheduleTimeZoneErrorMessage = undefined;
    loaded = false;
    contentAvailable = false;
    missing = false;
    errorMessage = undefined;
    updateErrorMessage = undefined;
    noticeMessage = undefined;
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
    const previousFocus = document.activeElement;
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
      else if (path === "/rules") missing = !session.capabilities.rules;
      else if (path === "/settings") {
        if (session.capabilities.scheduleSettings) {
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
          providerSettingsErrorMessage = undefined;
        } catch (cause) {
          if (
            current.signal.aborted ||
            (cause instanceof ApiError && cause.status === 401)
          )
            throw cause;
          providerSettings = undefined;
          providerSettingsErrorMessage = () =>
            cause instanceof ApiError
              ? cause.display($messages)
              : $messages(
                  "Could not load provider settings from the Nimbot Server.",
                );
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
          (view === "rules" && !session.capabilities.rules) ||
          (view === "settings" && !agent.capabilities.edit) ||
          (view === "token" && !agent.capabilities.replaceToken) ||
          (view === "delete" && !agent.capabilities.delete) ||
          (view === "process/stop" && !agent.capabilities.process?.stop) ||
          (view === "process/restart" && !agent.capabilities.process?.restart);
      } else
        missing = path !== "/agents/new" || !session.capabilities.createAgent;
      updateErrorMessage = undefined;
      contentAvailable = true;
      loaded = true;
      if (initial) void focusDestination(true, previousFocus);
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
        updateErrorMessage = () =>
          contentAvailable
            ? $messages(
                "Could not update this view ({0}). Showing the last loaded data.",
                viewLabel,
              )
            : $messages("Could not load this view ({0}).", viewLabel);
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
    handleError?: (error: ApiError) => boolean,
  ) {
    if (busy) return;
    busy = true;
    errorMessage = undefined;
    noticeMessage = undefined;
    const startedPath = path;
    try {
      const result = await post<T>(url, fields);
      if (path === startedPath) done(result);
      return true;
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
      if (cause instanceof ApiError && handleError?.(cause)) return;
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
        errorMessage = () =>
          $messages(
            "Could not confirm sign-in. Check your connection and try signing in again.",
          );
      } else
        errorMessage = () =>
          cause instanceof ApiError
            ? cause.display($messages)
            : $messages(
                "The result could not be confirmed. Refresh the status before retrying.",
              );
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
          noticeMessage = () =>
            mode === "token"
              ? $messages(
                  "Token saved. Restart this agent to reconnect its bot.",
                )
              : $messages("Changes saved.");
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
        noticeMessage = () => $messages("Telegram connection saved.");
        void load();
      },
    );
  }
  async function discordAction(
    kind: "save" | "remove" | "test",
    fields: Record<string, string>,
    handleSaveError?: (error: ApiError) => boolean,
  ) {
    if (!agent) return;
    if (kind === "test") {
      await mutate<
        import("../../server/src/notifications/notification-store.js").NotificationRecord
      >(
        `/api/agents/${encodeURIComponent(agent.id)}/discord/test`,
        fields,
        (result) => {
          noticeMessage = () =>
            result.status === "delivered"
              ? $messages("Discord test delivered.")
              : result.status === "sending"
                ? $messages(
                    "Discord test is still sending. Check its status again.",
                  )
                : result.status === "uncertain"
                  ? $messages(
                      "Discord delivery is uncertain. Check your DMs before sending a new test.",
                    )
                  : result.reason === "rate_limited"
                    ? $messages(
                        "Discord test was rate limited. Wait before sending a new test.",
                      )
                    : result.reason === "rejected"
                      ? $messages(
                          "Discord rejected the test. Check your DM settings and whether the bot is blocked.",
                        )
                      : $messages(
                          "Discord test failed. Check the saved connection and DM availability.",
                        );
        },
      );
      return;
    }
    return mutate<{ cleanupPending: boolean }>(
      `/api/agents/${encodeURIComponent(agent.id)}/discord${kind === "remove" ? "/remove" : ""}`,
      fields,
      (result) => {
        noticeMessage = () =>
          (kind === "remove"
            ? $messages("Discord removed.")
            : $messages("Discord connection saved.")) +
          (result.cleanupPending
            ? $messages(
                " An unused credential file could not be erased. Check server storage permissions.",
              )
            : "");
        void load();
      },
      handleSaveError,
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
          noticeMessage = () =>
            kind === "restart"
              ? $messages(
                  "Agent restarted. Active work may have been interrupted.",
                )
              : $messages("Agent stopped. Files and history were kept.");
        } else {
          noticeMessage = () => $messages("Agent started.");
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
        noticeMessage = () => $messages("Model saved for new turns.");
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
        noticeMessage = () =>
          kind === "save"
            ? $messages("API key saved for all agents.")
            : kind === "remove"
              ? $messages("Provider disconnected for all agents.")
              : kind === "cancel"
                ? $messages("Login status updated.")
                : $messages(
                    "Device login started. Complete authorization using the link below.",
                  );
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
          noticeMessage = () =>
            result.cleanupPending
              ? $messages("Integration saved. Credential cleanup is pending.")
              : $messages("Integration saved.");
        },
      );
    } else {
      await mutate<McpDefinition>(
        "/api/mcp",
        JSON.stringify(settings),
        (result) => {
          navigate(`/mcp/${encodeURIComponent(result.id)}`, true);
          noticeMessage = () => $messages("Integration saved.");
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
        noticeMessage = () =>
          result.cleanupPending
            ? $messages("MCP access updated. Credential cleanup is pending.")
            : $messages("MCP access updated.");
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
        noticeMessage = () => $messages("Cancellation requested.");
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
        noticeMessage = () =>
          kind === "grant"
            ? $messages("Grant added.")
            : $messages("Grant revoked.");
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
        noticeMessage = () => $messages("Rule added.");
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
        noticeMessage = () => $messages("Rule revoked.");
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
        noticeMessage = () => $messages("Note deleted.");
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
        noticeMessage = () => scheduleText.saved;
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
        noticeMessage = () =>
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
    if (
      url.origin !== location.origin ||
      (url.hash && !link.hasAttribute("data-option-link"))
    )
      return;
    event.preventDefault();
    if (busy) return;
    const next = url.pathname + url.search + url.hash;
    if (url.hash && url.pathname === path && url.search === pageSearch) {
      if (url.hash !== location.hash) history.pushState(null, "", next);
      optionQuery = "";
      if (loaded) void focusDestination();
    } else {
      navigate(next);
    }
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
    const pop = () => {
      if (location.pathname === path && location.search === pageSearch) {
        if (loaded && location.hash) void focusDestination(false);
      } else {
        navigate(location.pathname + location.search + location.hash, true);
      }
    };
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
  <title>{path === "/settings" ? $messages("Settings") : title} · Nimbot</title>
  <link rel="icon" type="image/svg+xml" href={logo} />
</svelte:head>
<a id="skip" href="#main">{$messages("Skip to main content")}</a>
{#snippet wordmark()}
  <a href="/" data-ui="wordmark" aria-label={$messages("Nimbot home")}>
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
    aria-label={$messages("Sign out")}
    disabled={busy}
    onclick={() => mutate("/api/logout", {}, expired)}
  >
    <Icon name="logout" size={inSidebar ? 18 : 16} />
    <span
      aria-hidden="true"
      data-ui={inSidebar ? "navigation-label" : undefined}
    >
      {$messages("Sign out")}
    </span>
  </ActionButton>
{/snippet}
{#snippet agentDirectory()}
  {#key path}
    <AgentHeader
      agents={status.agents}
      {options}
      current={currentAgent}
      showSwitcher={path !== "/"}
      section={switchSection}
      loading={path === "/" ? !loaded : directoryLoading}
      unavailable={path === "/" ? !!updateError : directoryUnavailable}
      refresh={refreshAgentDirectory}
      bind:query={optionQuery}
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
            />
            {$messages("Menu")}</ActionButton
          >{/if}
        {@render signOut(false)}
      </div>
    {:else}<span data-ui="installation"
        ><Icon name="shield" size={15} />
        {$messages("SELF-HOSTED & PRIVATE")}</span
      >{/if}
  </header>
{/if}
<div data-ui="panel-shell">
  {#if session && path !== "/login" && (!compact || menuOpen)}
    <nav
      aria-label={$messages("Main navigation")}
      data-ui="main-navigation"
      data-expanded={!rail || navigationExpanded}
    >
      {#if desktopSidebar}
        {@render wordmark()}
        <ActionButton
          variant="ghost"
          type="button"
          aria-label={navigationExpanded
            ? $messages("Hide labels")
            : $messages("Show labels")}
          aria-expanded={navigationExpanded}
          aria-controls="main-navigation-links"
          onclick={toggleLabels}
        >
          <Icon name={navigationExpanded ? "collapsePanel" : "expandPanel"} />
          {#if navigationExpanded}<span>{$messages("Hide labels")}</span>{/if}
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
      oninvalidcapture={(event) => localizeInvalidField(event, $messages)}
      oninputcapture={clearFieldValidation}
      data-page={path === "/login"
        ? "login"
        : path === "/"
          ? "dashboard"
          : "detail"}
    >
      {#if path !== "/login"}<p id="form-error" role="alert" tabindex="-1">
          {error}
        </p>{/if}
      {#if notice && path !== "/settings"}<p role="status">{notice}</p>{/if}
      {#if updateError}<p role="status">{updateError}</p>
        <ActionButton onclick={() => load()}
          >{$messages("Retry loading")} {viewLabel}</ActionButton
        >{/if}
      {#if path === "/login"}
        <section data-ui="sign-in" aria-label={$messages("Sign in")}>
          <small>{$messages("ADMINISTRATION")}</small>
          <h1 tabindex="-1">{$messages("Your agent workspace.")}</h1>
          <p>
            {$messages("Sign in to check the status of your installation.")}
          </p>
          <div data-ui="sign-in-language">
            <label for="login-language">{$messages("Language")}</label>
            <LanguageSelect id="login-language" />
          </div>
          <div class="panel-card">
            <form
              onsubmit={login}
              aria-describedby="form-error"
              aria-busy={busy}
            >
              <label for="password">{$messages("Administrator password")}</label
              >
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
                {$messages("Use the password configured on your server.")}
              </p>
              <p id="form-error" role="alert" tabindex="-1">{error}</p>
              <ActionButton variant="primary" type="submit" disabled={busy}
                >{busy
                  ? $messages("Signing in…")
                  : $messages("Sign in to the panel")}</ActionButton
              >
            </form>
          </div>
        </section>
      {:else if !loaded}<p role="status">{$messages("Loading…")}</p>
      {:else if missing}<h1 tabindex="-1">{$messages("Page not found.")}</h1>
        <p>{$messages("This agent or action is no longer available.")}</p>
        <ActionButton href="/">{$messages("All agents")}</ActionButton>
      {:else if !contentAvailable}
        <h1 tabindex="-1">{$messages("Status unavailable.")}</h1>
        <ActionButton href="/">{$messages("All agents")}</ActionButton>
      {:else if path === "/"}
        <Dashboard
          agents={status.agents}
          canCreate={session?.capabilities.createAgent ?? false}
          refresh={() => load()}
        />
      {:else if path === "/rules"}
        <Rules expireSession={expired} />
      {:else if path === "/settings"}
        <h1 tabindex="-1">{$messages("Settings")}</h1>
        <div class="settings-section-list">
          <section aria-labelledby="panel-appearance-heading">
            <div class="settings-section-description">
              <h2 id="panel-appearance-heading" class="card-title">
                <Icon name="settings" size={20} />
                <label for="panel-appearance">{$messages("Appearance")}</label>
              </h2>
              <p id="panel-appearance-help">
                {$messages("Changes apply immediately in this browser.")}
              </p>
            </div>
            <div class="panel-card settings-card">
              <Select
                id="panel-appearance"
                aria-describedby="panel-appearance-help"
                value={appearance}
                onchange={(event) => {
                  const value = event.currentTarget.value;
                  if (isAppearance(value)) {
                    appearance = value;
                    saveAppearance(value);
                  }
                }}
              >
                <option value="system">{$messages("System")}</option>
                <option value="light">{$messages("Light")}</option>
                <option value="dark">{$messages("Dark")}</option>
              </Select>
            </div>
          </section>
          <section aria-labelledby="panel-language-heading">
            <div class="settings-section-description">
              <h2 id="panel-language-heading" class="card-title">
                <label for="panel-language">{$messages("Language")}</label>
              </h2>
              <p id="panel-language-help">
                {$messages("Changes apply immediately in this browser.")}
              </p>
            </div>
            <div class="panel-card settings-card">
              <LanguageSelect
                id="panel-language"
                describedBy="panel-language-help"
              />
            </div>
          </section>
          {#if session?.capabilities.scheduleSettings}
            <section aria-labelledby="schedule-default-zone-heading">
              <div class="settings-section-description">
                <h2 id="schedule-default-zone-heading" class="card-title">
                  <Icon name="clock" size={20} />
                  <label for="schedule-default-zone"
                    >{$messages("Schedule time zone")}</label
                  >
                </h2>
                <p id="schedule-default-zone-help">
                  {$messages(
                    "Enter an IANA time zone such as America/New_York or UTC. This applies to new schedules created in Telegram and prefills the schedule form in the panel.",
                  )}
                </p>
              </div>
              <form
                class="panel-card settings-card"
                aria-busy={busy}
                aria-describedby="form-error"
                onsubmit={(event) => {
                  event.preventDefault();
                  if (busy) return;
                  scheduleTimeZoneErrorMessage = undefined;
                  void mutate<ScheduleDefaults>(
                    "/api/settings/schedules",
                    { timeZone: scheduleTimeZone },
                    (result) => {
                      scheduleTimeZone = result.timeZone;
                      noticeMessage = () =>
                        $messages("Schedule time zone saved.");
                    },
                    (cause) => {
                      if (cause.status !== 400) return false;
                      scheduleTimeZoneErrorMessage = () =>
                        cause.display($messages);
                      void tick().then(() => {
                        document
                          .getElementById("schedule-default-zone")
                          ?.focus();
                      });
                      return true;
                    },
                  );
                }}
              >
                <TextField
                  id="schedule-default-zone"
                  aria-describedby={scheduleTimeZoneError
                    ? "schedule-default-zone-help schedule-default-zone-error"
                    : "schedule-default-zone-help"}
                  aria-invalid={scheduleTimeZoneError ? "true" : undefined}
                  bind:value={scheduleTimeZone}
                  oninput={() => {
                    scheduleTimeZoneErrorMessage = undefined;
                    noticeMessage = undefined;
                  }}
                  required
                  disabled={busy}
                  spellcheck="false"
                />
                {#if scheduleTimeZoneError}
                  <p id="schedule-default-zone-error" role="alert">
                    {scheduleTimeZoneError}
                  </p>
                {/if}
                <ActionButton type="submit" variant="primary" disabled={busy}
                  >{busy
                    ? $messages("Saving…")
                    : $messages("Save time zone")}</ActionButton
                >
                <p class="settings-save-status" role="status">{notice}</p>
              </form>
            </section>
          {/if}
        </div>
      {:else if path === "/providers"}
        <ProviderSettings
          settings={providerSettings}
          loadError={providerSettingsError}
          {busy}
          action={providerAction}
          refresh={() => load()}
        />
      {:else if path === "/agents/new"}
        {#key path}<AgentForm mode="new" {busy} {submit} />{/key}
      {:else if path === "/mcp"}
        <h1 id="mcp-catalog" tabindex="-1">{$messages("MCP catalog")}</h1>
        <ActionButton variant="primary" href="/mcp/new"
          >{$messages("Add integration")}</ActionButton
        >
        {#if mcpDefinitions.length === 0}
          <p>{$messages("No integrations in the catalog.")}</p>
        {:else}
          <section class="panel-card" aria-label={$messages("Integrations")}>
            <ul>
              {#each mcpDefinitions as definition (definition.id)}
                <li>
                  <a href={`/mcp/${encodeURIComponent(definition.id)}`}
                    >{definition.label}</a
                  >
                  · {definition.enabled
                    ? $messages("Enabled")
                    : $messages("Disabled")}
                  {#if definition.blockedTools?.length}<span class="panel-badge"
                      >{$messages("Review needed")}</span
                    >{/if}
                </li>
              {/each}
            </ul>
          </section>
        {/if}
        <section class="grid gap-4" aria-labelledby="mcp-examples-heading">
          <h2 id="mcp-examples-heading">{$messages("Examples")}</h2>
          <ul class="grid gap-4 sm:grid-cols-3">
            {#each mcpExamples as example (example.id)}
              <li class="panel-card">
                <h3>{example.label}</h3>
                <p class="grow">
                  {translateDescription($messages, example.description)}
                </p>
                <ActionButton
                  class="self-start"
                  href={`/mcp/new?example=${encodeURIComponent(example.id)}`}
                  aria-label={$messages("Set up {0}", example.label)}
                  >{$messages("Set up")}</ActionButton
                >
              </li>
            {/each}
          </ul>
        </section>
      {:else if mcpRoute}
        <h1 tabindex="-1">
          {mcpDefinition
            ? $messages("Edit {0}", mcpDefinition.label)
            : mcpExample
              ? $messages("Set up {0}", mcpExample.label)
              : $messages("Add MCP integration")}
        </h1>
        <ActionButton href="/mcp">{$messages("Back to catalog")}</ActionButton>
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
          <h1 tabindex="-1">{$messages("Access for")} {agent.name}</h1>
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
              refresh={() => load()}
            />{/key}
        {:else if route[2] === "memory"}
          {#key agent.id}<Memory
              {agent}
              {memories}
              page={memoryPage}
              {busy}
              remove={deleteMemory}
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
        {:else if route[2] === "rules"}
          {#key agent.id}
            <Rules agentId={agent.id} expireSession={expired} />
          {/key}
        {:else if route[2] === "settings" || route[2] === "token"}
          {#key path}<AgentForm mode={route[2]} {agent} {busy} {submit} />{/key}
        {:else if route[2] === "process/stop" || route[2] === "process/restart"}
          <h1 tabindex="-1">
            {route[2] === "process/restart"
              ? $messages("Restart")
              : $messages("Stop")}
            {agent.name}?
          </h1>
          <p>
            {$messages("The Agent Host process will be")}
            {route[2] === "process/restart"
              ? $messages("stopped and started again")
              : $messages("stopped")}{$messages(
              ". Active work may be interrupted. Files and conversation history are kept.",
            )}
          </p>
          <div class="button-row">
            <ActionButton
              variant={route[2] === "process/restart" ? "primary" : "danger"}
              disabled={busy}
              onclick={() =>
                action(route?.[2] === "process/restart" ? "restart" : "stop")}
              >{busy
                ? $messages("Working…")
                : route[2] === "process/restart"
                  ? $messages("Confirm restart")
                  : $messages("Confirm stop")}</ActionButton
            >
            <ActionButton
              variant="ghost"
              href={`/agents/${encodeURIComponent(agent.id)}/setup`}
              >{$messages("Cancel")}</ActionButton
            >
          </div>
        {:else if route[2] === "delete"}
          <h1 tabindex="-1">{$messages("Delete")} {agent.name}?</h1>
          <p>
            {$messages(
              "Its Agent Host will stop. Agent data is kept unless you explicitly delete it below.",
            )}
          </p>
          {#if agent.botUsername}
            <p>
              {$messages(
                "Local Telegram credentials and the chat binding will be erased. The Telegram bot can be revoked separately in BotFather.",
              )}
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
              >{$messages(
                "Also permanently delete the agent data directory and AI conversation history, including its workspace, task history and browser profile.",
              )}</Checkbox
            >
            <div class="button-row">
              <ActionButton variant="danger" type="submit" disabled={busy}
                >{busy
                  ? $messages("Deleting…")
                  : deleteData
                    ? $messages("Delete agent and its data")
                    : $messages("Delete agent, keep its data")}</ActionButton
              ><ActionButton
                variant="ghost"
                href={`/agents/${encodeURIComponent(agent.id)}/setup`}
                >{$messages("Cancel")}</ActionButton
              >
            </div>
          </form>
        {/if}
      {/if}
    </main>
  </div>
</div>
