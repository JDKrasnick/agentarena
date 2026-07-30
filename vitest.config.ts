import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".context/**"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Arena integration and smoke tests each create nested Git worktrees and
    // child agent processes. Parallel files contend for those resources and
    // turn otherwise deterministic tests into timeout failures.
    fileParallelism: false,
    restoreMocks: true,
  },
});
