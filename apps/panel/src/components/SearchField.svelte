<script lang="ts">
  import Icon from "./Icon.svelte";
  let {
    label = "Search",
    placeholder = "Search…",
    value = $bindable(""),
  }: { label?: string; placeholder?: string; value?: string } = $props();
</script>

<label class="input" data-ui="search"
  ><Icon name="search" size={17} /><input
    type="search"
    aria-label={label}
    {placeholder}
    bind:value
  /></label
>
