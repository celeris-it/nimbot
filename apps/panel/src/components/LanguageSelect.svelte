<script lang="ts">
  import Select from "./Select.svelte";
  import {
    isLanguagePreference,
    languagePreference,
    messages,
    saveLanguage,
  } from "../i18n/language.js";

  let { id, describedBy }: { id: string; describedBy?: string } = $props();
</script>

<Select
  {id}
  aria-describedby={describedBy}
  value={$languagePreference}
  onchange={(event) => {
    const value = event.currentTarget.value;
    if (isLanguagePreference(value)) saveLanguage(value);
  }}
>
  <option value="browser">{$messages("Browser default")}</option>
  <option value="en" lang="en">English</option>
  <option value="es" lang="es">Español</option>
</Select>
