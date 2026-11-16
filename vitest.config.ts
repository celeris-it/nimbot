import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // Compiled copies of the tests in dist must not run a second time.
  test: {
    exclude: [...configDefaults.exclude, "**/dist/**", "**/*.e2e.ts"],
    // Structured logs would drown test output; logger tests inject their own sink.
    env: { NIMBOT_LOG: "silent" },
  },
});
