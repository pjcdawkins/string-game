import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Flat config (ESLint 9). Type-aware linting is intentionally left off: the
// `typecheck` script (`tsc --noEmit`) already gives us the full type picture,
// so ESLint stays fast and config-light with the non-type-checked ruleset.
export default tseslint.config(
  {
    // Generated / vendored output — never linted.
    ignores: ["dist/**", "node_modules/**"],
  },

  // Base rules for everything we lint (TS sources, tests, Node scripts).
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Browser + AudioWorklet runtime: the app and its DSP worklet.
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
    },
  },

  // Node runtime: Vitest specs, Playwright/e2e harnesses, build scripts, and
  // root config files. Tests also touch browser globals via the code they
  // import, so both sets are in scope.
  {
    files: [
      "test/**/*.ts",
      "e2e/**/*.mjs",
      "scripts/**/*.mjs",
      "*.ts",
      "*.mjs",
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
);
