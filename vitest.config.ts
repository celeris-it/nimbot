import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // Compiled copies of the tests in dist must not run a second time.
  test: { exclude: [...configDefaults.exclude, "**/dist/**"] },
});
