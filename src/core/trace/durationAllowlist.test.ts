// Feature: docs/reference/specs/tracing.md item 8 — the duration ratchet
// (decision 0046): every minutes-scale duration literal outside
// src/core/budgets.ts is on an allowlist that can only shrink, and the ESLint
// rule and the scanner agree on what a duration literal is.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWLIST_PATH,
  allowlistProblems,
  countDurationLiterals,
  productionFiles,
  RULE_IDS,
  scan,
  SCANNER_IDS,
} from "./durationScan.mjs";

type Allowlist = Record<string, number>;

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("duration ratchet", () => {
  it("the scanner and the ESLint rule name exactly the same duration literals", () => {
    expect([...SCANNER_IDS].sort()).toEqual([...RULE_IDS].sort());
  });

  it("counts a number times 60000, a number times a minute constant, and a bare minute-scale literal; seconds-scale timeouts, Date arithmetic and the count itself are not literals", () => {
    const ts = `
      const a = 5 * 60_000; const b = 60000 * 3; const c = 2 * MIN; const d = MINUTE_MS * 4;
      const e = 900_000; const f = 3_600_000; const g = 86400000;
      const h = 5_000; const i = 30_000; const j = 250; const k = 6; const l = new Date(a); const m = 45 * 6;
    `;
    expect(countDurationLiterals("x.ts", ts)).toEqual({ "n * 60000": 2, "n * MIN": 2, "minute-scale literal": 3 });
    const vue = `<template><div>{{ x }}</div></template>\n<script setup lang="ts">const x = 10 * 60_000;</script>\n<script lang="ts">export const y = 900_000;</script>\n<style>.a { color: red }</style>`;
    expect(countDurationLiterals("x.vue", vue)).toEqual({ "n * 60000": 1, "minute-scale literal": 1 });
    expect(countDurationLiterals("x.mjs", "export const t = 15 * MIN;")).toEqual({ "n * MIN": 1 });
    expect(countDurationLiterals("x.ts", "const none = 12 * 5_000;")).toEqual({});
  });

  // The two tests below walk the whole tree; the scan has taken 6–9 s on a
  // loaded host against the 5 s default while the same check passed as a
  // script. The bound is the host's, not the scanner's.
  it(
    "the production file set excludes tests, test helpers, the budgets module and the two ratchets' own files",
    { timeout: 60_000 },
    () => {
      const files = productionFiles(ROOT);
      expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
      expect(files).not.toContain("src/core/budgets.ts");
      expect(files).not.toContain("src/core/trace/durationReads.mjs");
      expect(files).not.toContain("src/core/trace/durationScan.mjs");
      expect(files.some((f) => f.startsWith("src/core/testing/"))).toBe(false);
      expect(files).toContain("src/core/dispatcher.ts");
    },
  );

  it(
    "the allowlist matches the tree exactly: no file grew a literal, no listed file has fewer than recorded (regenerate with `npm run clock:gen` when a literal becomes a row)",
    { timeout: 60_000 },
    () => {
      const listed = JSON.parse(readFileSync(join(ROOT, ALLOWLIST_PATH), "utf8")) as Allowlist;
      const current = scan(ROOT);
      expect(allowlistProblems(current, listed)).toEqual([]);
      expect(current).toEqual(listed);
      // the problem report names both directions, and where the number belongs
      expect(allowlistProblems({ "a.ts": 2 }, { "a.ts": 1, "b.ts": 1 })).toEqual([
        "a.ts: 2 duration literal(s), allowlist permits 1 — move the number into src/core/budgets.ts",
        "b.ts: allowlist says 1 but 0 remain — shrink the entry (npm run clock:gen)",
      ]);
    },
  );
});
