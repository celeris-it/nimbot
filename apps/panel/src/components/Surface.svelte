<script lang="ts">
  import type { Snippet } from "svelte";
  let {
    title,
    description,
    children,
    actions,
    tone = "dark",
  }: {
    title?: string;
    description?: string;
    children: Snippet;
    actions?: Snippet;
    tone?: "dark" | "muted";
  } = $props();
</script>

<section
  class="card"
  data-ui="surface"
  data-theme="nimbot"
  data-tone={tone}
  aria-label={title}
>
  {#if title || actions}<div data-ui="surface-heading">
      <div>
        {#if title}<h2>{title}</h2>{/if}{#if description}<p>
            {description}
          </p>{/if}
      </div>
      {#if actions}<div>{@render actions()}</div>{/if}
    </div>{/if}
  {@render children()}
</section>
