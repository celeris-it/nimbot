<script lang="ts">
  import type { Snippet } from "svelte";
  let {
    title,
    description,
    children,
    actions,
    tone = "dark",
    glow,
  }: {
    title?: string;
    description?: string;
    children: Snippet;
    actions?: Snippet;
    tone?: "dark" | "muted";
    glow?: "blue" | "amber" | "teal";
  } = $props();
</script>

<section
  class="panel-card"
  data-ui="surface"
  data-tone={tone}
  data-glow={glow}
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
