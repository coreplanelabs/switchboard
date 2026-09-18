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
import { DURATION_BAN_EXEMPT, DURATION_BAN_FILES, DURATION_READS } from "./src/core/trace/durationReads.mjs";
import DURATION_ALLOWLIST from "./src/core/trace/durationAllowlist.json" with { type: "json" };
import { HOST_TOOLING_FILES, SECRET_ENV_EXEMPT, SECRET_ENV_FILES, secretEnvPlugin } from "./src/secretEnv.mjs";
import { REFUSAL_FENCE_EXEMPT, REFUSAL_FENCE_FILES, refusalFencePlugin } from "./src/refusalFence.mjs";

// The clock ratchet (docs/reference/specs/tracing.md item 8): production code reads the wall
// clock only through the injected `clock()` — `src/core/trace/clock.ts` and the
// web's `wallClock.ts` are the two files that touch `Date`. The allowlist that
// once exempted files still reading directly is empty; `clock-ban` applies
// everywhere the ratchet does (src/core/trace/clockAllowlist.test.ts keeps it so).
//
// no-raw-env (docs/reference/specs/routing-and-config.md item 19): a credential is read
// from `process.env` in src/secrets.ts and nowhere else. Every other production
// file under src/ may read the public variables by name and nothing more; the
// operator-side tooling keeps its bare `process.env` (it spawns wrangler with
// the operator's environment) but may not read a secret by name either.

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "dist/**",
      "packages/*/dist/**",
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
    files: [
      "src/**/*.ts",
      "src/**/*.mjs",
      "scripts/**/*.{ts,mjs,mts}",
      "deploy/**/*.{ts,mjs}",
      "packages/**/*.{js,mts}",
    ],
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
  {
    // duration-ban: a minutes-scale duration literal outside src/core/budgets.ts is a
    // lint error in every file the duration allowlist does not still list
    // (decision 0046; the allowlist only shrinks). The listed files are exempt
    // here until their literals become rows; `npm run duration:check` holds
    // the list itself.
    files: [...DURATION_BAN_FILES],
    ignores: [...DURATION_BAN_EXEMPT, ...Object.keys(DURATION_ALLOWLIST)],
    rules: {
      "no-restricted-syntax": ["error", ...DURATION_READS.map((r) => ({ selector: r.selector, message: r.message }))],
    },
  },
  {
    files: [...SECRET_ENV_FILES],
    ignores: [...SECRET_ENV_EXEMPT, ...HOST_TOOLING_FILES],
    plugins: { secrets: secretEnvPlugin },
    rules: { "secrets/no-raw-env": "error" },
  },
  {
    files: [...HOST_TOOLING_FILES],
    ignores: [...SECRET_ENV_EXEMPT],
    plugins: { secrets: secretEnvPlugin },
    rules: { "secrets/no-raw-env": ["error", { hostTooling: true }] },
  },
  {
    // no-raw-refusal (record 0054, routing-and-config item 21): a producing
    // module refuses through the seam — a Refusal, never a raw reply or throw.
    files: [...REFUSAL_FENCE_FILES],
    ignores: [...REFUSAL_FENCE_EXEMPT],
    plugins: { refusals: refusalFencePlugin },
    rules: { "refusals/no-raw-refusal": "error" },
  },
  prettier,
);
