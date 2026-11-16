import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/; their copies of the tests aren't ours to run.
    exclude: [...configDefaults.exclude, ".claude/**"],
    // The Visual core's property tests try hundreds of random documents each;
    // give them room on slow or busy machines (CI runners especially).
    testTimeout: 60_000,
  },
});
