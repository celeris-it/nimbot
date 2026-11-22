<script lang="ts">
  import Icon from "./Icon.svelte";
  let {
    label = "Search",
    placeholder = "Search…",
    value = $bindable(""),
    onfocus,
    oninput,
  }: {
    label?: string;
    placeholder?: string;
    value?: string;
    onfocus?: (event: FocusEvent) => void;
    oninput?: (event: Event) => void;
  } = $props();
</script>

<label class="panel-input" data-ui="search"
  ><Icon name="search" size={17} /><input
    type="search"
    aria-label={label}
    {placeholder}
    {onfocus}
    {oninput}
    bind:value
  /></label
>
