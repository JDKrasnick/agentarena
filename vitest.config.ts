import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      reporter: ["text", "json", "html"],
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
  },
});
