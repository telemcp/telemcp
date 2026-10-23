import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
    fileParallelism: false,
    testTimeout: 15000,
  },
});
