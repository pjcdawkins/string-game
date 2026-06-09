/// <reference types="vitest" />
import { defineConfig } from "vite";

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
  },
});
