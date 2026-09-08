// One lint configuration for every package in the workspace: the bot and its
// scripts (TypeScript, Node), the dashboard (Vue single-file components), and
// the Workers. Formatting is Prettier's job — eslint-config-prettier switches
// off every stylistic rule so the two never disagree.
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import vue from "eslint-plugin-vue";
import globals from "globals";
import tseslint from "typescript-eslint";
import vueParser from "vue-eslint-parser";
import { CLOCK_BAN_EXEMPT, CLOCK_BAN_FILES, CLOCK_READS } from "./src/core/trace/clockReads.mjs";

// The clock ratchet (docs/reference/specs/tracing.md item 8): production code reads the wall
// clock only through the injected `clock()` — `src/core/trace/clock.ts` and the
// web's `wallClock.ts` are the two files that touch `Date`. The allowlist that
// once exempted files still reading directly is empty; `clock-ban` applies
// everywhere the ratchet does (src/core/trace/clockAllowlist.test.ts keeps it so).

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "dist/**",
      "web/dist/**",
      "docs/.vitepress/dist/**",
      "docs/.vitepress/cache/**",
      "data/**",
      "workspaces/**",
      "skills/**",
      "web/auto-imports.d.ts",
      "web/components.d.ts",
      "src/core/__snapshots__/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs["flat/recommended"],
  {
    // Node-side TypeScript and scripts.
    files: ["src/**/*.ts", "src/**/*.mjs", "scripts/**/*.{ts,mjs,mts}", "deploy/**/*.{ts,mjs}"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The dashboard and the docs theme: Vue SFCs with TypeScript inside, browser globals.
    files: ["web/**/*.vue", "web/**/*.ts", "docs/.vitepress/theme/**/*.vue", "docs/.vitepress/theme/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser },
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, extraFileExtensions: [".vue"], sourceType: "module" },
    },
  },
  {
    rules: {
      // The codebase leans on `_`-prefixed intentional unused bindings.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // A binding captured by a closure before its single later assignment
      // (wiring resolved after construction) legitimately needs `let`.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    },
  },
  {
    // Tests and test helpers: doubles reach into SDK shapes through `any`, and a
    // test file may define several throwaway components. Production code keeps
    // both rules.
    files: ["**/*.test.ts", "**/*.test.mjs", "web/src/testing/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "vue/one-component-per-file": "off",
    },
  },
  {
    // clock-ban: a direct wall-clock read is a lint error everywhere the ratchet applies.
    files: [...CLOCK_BAN_FILES],
    ignores: [...CLOCK_BAN_EXEMPT],
    rules: {
      "no-restricted-syntax": ["error", ...CLOCK_READS.map((r) => ({ selector: r.selector, message: r.message }))],
    },
  },
  prettier,
);
