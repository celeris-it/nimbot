<script lang="ts">
  import { messages } from "../i18n/language.js";
  import Icon from "./Icon.svelte";
  let {
    label,
    placeholder,
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
    aria-label={label ?? $messages("Search")}
    placeholder={placeholder ?? $messages("Search…")}
    {onfocus}
    {oninput}
    bind:value
  /></label
>
