import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    target: "es2020",
  },
  worker: {
    format: "es",
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
