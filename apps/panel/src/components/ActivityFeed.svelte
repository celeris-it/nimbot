<script lang="ts">
  import { formattingLocale, messages } from "../i18n/language.js";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.js";
  let {
    label,
    items,
  }: {
    label?: string;
    items: Array<{
      id: string;
      title: string;
      description?: string;
      at: string;
      icon?: IconName;
    }>;
  } = $props();
</script>

<section data-ui="activity" aria-label={label ?? $messages("Recent activity")}>
  <h3>{label}</h3>
  <ol>
    {#each items as item (item.id)}<li>
        <span><Icon name={item.icon ?? "activity"} size={16} /></span>
        <div>
          <strong>{item.title}</strong>{#if item.description}<p>
              {item.description}
            </p>{/if}<time datetime={item.at}
            >{new Date(item.at).toLocaleString($formattingLocale)}</time
          >
        </div>
      </li>{:else}<li>{$messages("No activity recorded.")}</li>{/each}
  </ol>
</section>
