<script lang="ts">
  import { onMount, tick } from "svelte";
  import type {
    AgentDetail,
    PanelSession,
    PanelStatus,
    ProviderStatus,
  } from "../../server/src/panel-contracts.js";
  import { ApiError, post, request } from "./api.js";
  import Dashboard from "./Dashboard.svelte";
  import { Icon } from "./components/index.js";
  import AgentForm from "./AgentForm.svelte";
  import AgentStatus from "./AgentStatus.svelte";
  import ProviderSettings from "./ProviderSettings.svelte";

  let path = $state(location.pathname);
  let session = $state<PanelSession>();
  let status = $state<PanelStatus>({ agents: [] });
  let agent = $state<AgentDetail>();
  let providers = $state<ProviderStatus[]>([]);
  let loaded = $state(false);
  let contentAvailable = $state(false);
  let missing = $state(false);
  let busy = $state(false);
  let error = $state("");
  let updateError = $state("");
  let notice = $state("");
  let password = $state("");
  let deleteData = $state(false);
  let controller: AbortController | undefined;
  let inFlight = false;
  let route = $derived(
    path.match(
      /^\/agents\/([^/]+)\/(setup|settings|token|delete|container\/stop)$/,
    ),
  );
  let title = $derived(
    path === "/login"
      ? "Sign in"
      : path === "/"
        ? "Agents"
        : path === "/settings/providers"
          ? "AI providers"
          : path === "/agents/new"
            ? "Create agent"
            : route?.[2] === "settings"
              ? "Edit agent"
              : route?.[2] === "token"
                ? "Bot token"
                : route?.[2] === "delete"
                  ? "Delete agent"
                  : route?.[2] === "container/stop"
                    ? "Stop agent"
                    : "Agent setup",
  );

  async function focusHeading() {
    await tick();
    document.querySelector<HTMLElement>("h1")?.focus();
  }
  function navigate(next: string, replace = false) {
    controller?.abort();
    controller = undefined;
    inFlight = false;
    if (replace) history.replaceState(null, "", next);
    else history.pushState(null, "", next);
    path = new URL(next, location.origin).pathname;
    agent = undefined;
    loaded = false;
    contentAvailable = false;
    missing = false;
    error = "";
    updateError = "";
    notice = "";
    password = "";
    deleteData = false;
    void load();
  }
  function expired() {
    session = undefined;
    navigate("/login", true);
  }
  async function load() {
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
      else if (path === "/settings/providers") {
        providers = (
          await request<{ providers: ProviderStatus[] }>("/api/providers", {
            signal: current.signal,
          })
        ).providers;
      } else if (route) {
        agent = await request<AgentDetail>(`/api/agents/${route[1]}`, {
          signal: current.signal,
        });
        const view = route[2];
        missing =
          (view === "settings" && !agent.capabilities.edit) ||
          (view === "token" && !agent.capabilities.replaceToken) ||
          (view === "delete" && !agent.capabilities.delete) ||
          (view === "container/stop" && !agent.capabilities.container);
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
      } else
        updateError = contentAvailable
          ? "Could not update the status. The last known state is shown. Refresh to try again."
          : "Could not load the status. Refresh to try again.";
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
    fields: Record<string, string>,
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
              ? "Token saved. If the bot is already connected, restart the server to apply the change."
              : "Changes saved.";
        },
      );
    }
  }
  async function discordAction(
    kind: "save" | "remove" | "test",
    fields: Record<string, string>,
  ) {
    if (!agent) return;
    if (kind === "test") {
      await mutate<
        import("../../server/src/notification-store.js").NotificationRecord
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
  async function action(
    kind: "start" | "cancel" | "retry" | "stop" | "delete",
  ) {
    if (!agent) return;
    const id = encodeURIComponent(agent.id);
    const target =
      kind === "cancel"
        ? "provision/cancel"
        : kind === "retry"
          ? "provision"
          : kind === "delete"
            ? "delete"
            : "container";
    await mutate(
      `/api/agents/${id}/${target}`,
      { action: kind, confirm: agent.id, deleteData: String(deleteData) },
      () => {
        if (kind === "delete") navigate("/");
        else if (kind === "stop") navigate(`/agents/${id}/setup`);
        else {
          notice =
            kind === "cancel"
              ? "Cancellation requested."
              : kind === "retry"
                ? "Setup restarted."
                : "Operation sent to Docker. The Agent Host may take a few seconds to become available.";
          controller?.abort();
          controller = undefined;
          inFlight = false;
          void load();
        }
      },
    );
  }
  async function providerAction(id: string, kind: "save" | "remove", key = "") {
    await mutate(
      `/api/providers/${encodeURIComponent(id)}${kind === "remove" ? "/remove" : ""}`,
      kind === "save" ? { key } : {},
      () => {
        notice =
          kind === "save"
            ? "API key saved. Changes apply to the next task."
            : "API key removed. Running tasks keep their current key.";
        void load();
      },
    );
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
      if (!document.hidden && !busy && (path === "/" || route?.[2] === "setup"))
        void load();
    }, 5000);
    void load();
    return () => {
      clearInterval(timer);
      controller?.abort();
      document.removeEventListener("click", click);
      window.removeEventListener("popstate", pop);
      document.removeEventListener("visibilitychange", visible);
    };
  });
</script>

<svelte:head><title>{title} · Nimbot</title></svelte:head>
<a id="skip" href="#main">Skip to main content</a>
<header>
  <a href="/" data-ui="wordmark" aria-label="Nimbot home"
    ><svg
      width="30"
      height="30"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      ><path
        d="M16 2v28M2 16h28M6 6l20 20M6 26 26 6"
        stroke="currentColor"
        stroke-width="2"
      /><circle cx="16" cy="16" r="5" fill="currentColor" /></svg
    >nimbot<span data-ui="wordmark-dot">.</span></a
  >
  {#if session && path !== "/login"}
    <nav aria-label="Main navigation">
      <a href="/" aria-current={path === "/" ? "page" : undefined}
        ><Icon name="grid" size={15} /> Agents</a
      >{#if session.capabilities.createAgent}<a
          href="/agents/new"
          aria-current={path === "/agents/new" ? "page" : undefined}
          ><Icon name="plus" size={15} /> New agent</a
        >{/if}
      <a
        href="/settings/providers"
        aria-current={path === "/settings/providers" ? "page" : undefined}
        >AI providers</a
      >
    </nav>
    <div data-ui="header-actions">
      <span data-ui="installation"
        ><Icon name="shield" size={15} /> Private installation</span
      ><button
        class="btn btn-ghost"
        disabled={busy}
        onclick={() => mutate("/api/logout", {}, expired)}
        ><Icon name="logout" size={16} /> Sign out</button
      >
    </div>
  {:else}<span data-ui="installation"
      ><Icon name="shield" size={15} /> SELF-HOSTED & PRIVATE</span
    >{/if}
</header>
<main
  id="main"
  tabindex="-1"
  data-page={path === "/login"
    ? "login"
    : path === "/"
      ? "dashboard"
      : "detail"}
>
  <p id="form-error" role="alert" tabindex="-1">{error}</p>
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if updateError}<p role="status">{updateError}</p>
    <button class="btn" onclick={() => load()}>Refresh status</button>{/if}
  {#if path === "/login"}
    <section aria-label="Sign in">
      <small>ADMINISTRATION</small>
      <h1 tabindex="-1">Your agent workspace.</h1>
      <p>Sign in to check the status of your installation.</p>
      <div class="card">
        <form onsubmit={login} aria-describedby="form-error" aria-busy={busy}>
          <label for="password">Administrator password</label>
          <input
            class="input"
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
            maxlength="256"
            aria-describedby="password-help form-error"
            bind:value={password}
          />
          <p id="password-help">Use the password configured on your server.</p>
          <button class="btn" type="submit" disabled={busy}
            >{busy ? "Signing in…" : "Sign in to the panel"}</button
          >
        </form>
      </div>
    </section>
  {:else if !loaded}<p role="status">Loading…</p>
  {:else if missing}<h1 tabindex="-1">Page not found.</h1>
    <p>This agent or action is no longer available.</p>
    <a class="btn" href="/">Back to panel</a>
  {:else if !contentAvailable}
    <h1 tabindex="-1">Status unavailable.</h1>
    <a class="btn" href="/">Back to panel</a>
  {:else if path === "/"}
    <Dashboard
      agents={status.agents}
      canCreate={session?.capabilities.createAgent ?? false}
      refresh={() => load()}
    />
  {:else if path === "/settings/providers"}
    <ProviderSettings {providers} {busy} action={providerAction} />
  {:else if path === "/agents/new"}
    {#key path}<AgentForm mode="new" {busy} {submit} />{/key}
  {:else if agent && route}
    {#if route[2] === "setup"}<AgentStatus
        {agent}
        {busy}
        {action}
        {discordAction}
        refresh={() => load()}
      />
    {:else if route[2] === "settings" || route[2] === "token"}
      {#key path}<AgentForm mode={route[2]} {agent} {busy} {submit} />{/key}
    {:else if route[2] === "container/stop"}
      <h1 tabindex="-1">Stop {agent.name}?</h1>
      <p>
        Its container will be stopped. An active task may be interrupted; its
        status will be confirmed when the agent is available again. Files and
        history are kept.
      </p>
      <button class="btn" disabled={busy} onclick={() => action("stop")}
        >Confirm stop</button
      ><a class="btn" href={`/agents/${encodeURIComponent(agent.id)}/setup`}
        >Cancel</a
      >
    {:else if route[2] === "delete"}
      <h1 tabindex="-1">Delete {agent.name}?</h1>
      <p>
        Its container will be stopped and removed, its Telegram polling stopped,
        and its local bot binding and saved credentials erased.
      </p>
      <p>
        This does not delete the bot in Telegram. Remove or revoke it separately
        with BotFather if you no longer need it.
      </p>
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void action("delete");
        }}
        aria-describedby="form-error"
        aria-busy={busy}
      >
        <label
          ><input class="checkbox" type="checkbox" bind:checked={deleteData} /> Also
          permanently delete the persistent volume (workspace files and history).
          Leave unchecked to keep it.</label
        >
        <button class="btn" type="submit" disabled={busy}
          >Confirm deletion</button
        ><a class="btn" href={`/agents/${encodeURIComponent(agent.id)}/setup`}
          >Cancel</a
        >
      </form>
    {/if}
  {/if}
</main>
