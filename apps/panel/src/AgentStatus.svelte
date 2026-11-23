<script lang="ts">
  import { formattingLocale, messages } from "./i18n/language.js";
  import type { AgentDetail } from "../../server/src/panel/panel-contracts.js";
  import { providers } from "../../server/src/providers/provider-contracts.js";
  import { ActionButton, Icon } from "./components/index.js";
  import { processLabels } from "./labels.js";
  let {
    agent,
    busy,
    action,
    refresh,
  }: {
    agent: AgentDetail;
    busy: boolean;
    action: (kind: "start") => Promise<void>;
    refresh: () => void;
  } = $props();
  const providerLabels = $derived({
    available: $messages("Available"),
    rejected: $messages("Reconnect required"),
    restricted: $messages("Access restricted"),
    rate_limited: $messages("Rate limited"),
    unavailable: $messages("Unavailable"),
    unverified: $messages("Unverified"),
    not_configured: $messages("Not configured"),
  });
  let base = $derived(`/agents/${encodeURIComponent(agent.id)}`);
  let available = $derived(
    agent.hostState
      ? agent.hostState === "ready" || agent.hostState === "busy"
      : false,
  );
  let processMessage = $derived(
    agent.process?.state === "starting"
      ? $messages(
          "The Agent Host is starting. Wait for the operation to finish.",
        )
      : agent.process?.state === "stopping"
        ? $messages(
            "The Agent Host is stopping. Wait for the operation to finish.",
          )
        : available
          ? $messages("The Agent Host is available.")
          : agent.process?.state === "running"
            ? $messages(
                "The process is running, but its Host API is unavailable. Refresh status or restart the agent.",
              )
            : $messages(
                "The agent is saved. Start the Agent Host to make it available.",
              ),
  );
</script>

<h1 class="sr-only" tabindex="-1">{agent.name}</h1>
<ActionButton href={`${base}/channels`}>
  <Icon name="link" size={16} />{$messages("Manage channels")}
</ActionButton>
<div class="settings-section-list" data-ui="agent-overview">
  <section aria-labelledby="agent-host-heading">
    <div class="settings-section-description">
      <h2 id="agent-host-heading" class="card-title">
        <Icon name="server" size={20} />{agent.process
          ? $messages(
              "Agent Host {0}.",
              $messages(processLabels[agent.process.state]).toLowerCase(),
            )
          : $messages("Agent Host unavailable.")}
      </h2>
      <p>{processMessage}</p>
    </div>
    <div class="panel-card">
      <dl>
        {#if agent.process}
          <dt>{$messages("Process")}</dt>
          <dd>{$messages(processLabels[agent.process.state])}</dd>
        {/if}
        {#if agent.hostState}
          <dt>{$messages("Host API")}</dt>
          <dd>
            {{
              ready: $messages("Available"),
              busy: $messages("Busy"),
              unavailable: $messages("Offline"),
            }[agent.hostState]}
          </dd>
        {/if}
        {#if agent.process}
          <dt>{$messages("After a Server restart")}</dt>
          <dd>
            {agent.process.desiredState === "running"
              ? $messages("Restore this agent’s Host")
              : $messages("Leave this agent stopped")}
          </dd>
        {/if}
        <dt>{$messages("Identifier")}</dt>
        <dd>{agent.id}</dd>
      </dl>
      <div class="button-row">
        {#if agent.process && agent.capabilities.process?.start}<ActionButton
            variant="primary"
            disabled={busy}
            onclick={() => action("start")}
            ><Icon name="play" size={16} />{busy
              ? $messages("Starting…")
              : $messages("Start agent")}</ActionButton
          >{/if}
        {#if agent.process && agent.capabilities.process?.stop}<ActionButton
            variant="danger"
            href={`${base}/process/stop`}
            ><Icon name="stop" size={16} />{$messages(
              "Stop agent…",
            )}</ActionButton
          >{/if}
        {#if agent.process && agent.capabilities.process?.restart}<ActionButton
            variant="warning"
            href={`${base}/process/restart`}
            ><Icon name="restart" size={16} />{$messages(
              "Restart agent…",
            )}</ActionButton
          >{/if}
        <ActionButton variant="info" onclick={refresh}
          ><Icon name="refresh" size={16} />{$messages(
            "Refresh status",
          )}</ActionButton
        >
      </div>
    </div>
  </section>
  {#if agent.providerChecks}
    <section aria-labelledby="ai-provider-status">
      <div class="settings-section-description">
        <h2 id="ai-provider-status" class="card-title">
          <Icon name="cpu" size={20} />{$messages("AI provider status")}
        </h2>
      </div>
      <div class="panel-card">
        {#if agent.providerChecks.length}
          <dl>
            {#each agent.providerChecks as check (check.id)}
              <dt>
                {providers.find((provider) => provider.id === check.id)?.name}
              </dt>
              <dd>
                {providerLabels[check.state]}
                ·
                <time datetime={new Date(check.checkedAt).toISOString()}>
                  {new Date(check.checkedAt).toLocaleString($formattingLocale)}
                </time>
              </dd>
            {/each}
          </dl>
        {:else}
          <p>
            {agent.hostState === "unavailable"
              ? $messages("Agent Host is offline.")
              : $messages("No provider check results yet.")}
          </p>
        {/if}
      </div>
    </section>
  {/if}
  {#if agent.capabilities.delete}
    <section aria-label={$messages("Danger zone")} data-tone="danger">
      <div class="settings-section-description">
        <h2 class="card-title">
          <Icon name="alert" size={20} />{$messages("Danger zone")}
        </h2>
        <p>
          {$messages(
            "Deleting an agent stops its Host. Its data is kept unless you choose to delete it on the next page.",
          )}
        </p>
      </div>
      <div class="panel-card" data-tone="danger">
        <ActionButton variant="danger" href={`${base}/delete`}
          ><Icon name="trash" size={16} />{$messages(
            "Delete agent…",
          )}</ActionButton
        >
      </div>
    </section>
  {/if}
</div>
