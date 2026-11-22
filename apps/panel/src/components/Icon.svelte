<script lang="ts">
  import { icons, type IconName } from "./icons.js";

  const sizes = {
    14: "text-[14px]",
    15: "text-[15px]",
    16: "text-[16px]",
    17: "text-[17px]",
    18: "text-[18px]",
    20: "text-[20px]",
    26: "text-[26px]",
    28: "text-[28px]",
    34: "text-[34px]",
  } as const;

  let { name, size = 18 }: { name: IconName; size?: keyof typeof sizes } =
    $props();
</script>

<span
  class={[icons[name], sizes[size], "shrink-0 align-middle"]}
  data-ui="icon"
  aria-hidden="true"
></span>
