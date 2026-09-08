// Feature: features/tracing.md — the clock ratchet: the allowlist of direct
// wall-clock reads can only shrink, and the ESLint rule and the scanner agree
// on what a read is.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWLIST_PATH,
  allowlistProblems,
  countClockReads,
  productionFiles,
  RULE_IDS,
  scan,
  SCANNER_IDS,
} from "./clockScan.mjs";

type Allowlist = Record<string, number>;

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("clock ratchet", () => {
  it("the scanner and the ESLint rule name exactly the same clock reads", () => {
    expect([...SCANNER_IDS].sort()).toEqual([...RULE_IDS].sort());
  });

  it("counts every read shape, ignores Date.parse/Date.UTC and new Date(x), and reads a .vue file's script blocks", () => {
    const ts = `
      const a = Date.now(); const b = globalThis.Date.now(); const c = Date["now"]();
      const d = new Date(); const e = new Date(a); const f = Date.parse("x"); const g = Date.UTC(2026, 1);
      const h = performance.now(); const i = process.hrtime(); const j = process.hrtime.bigint(); const k = process.uptime();
    `;
    expect(countClockReads("x.ts", ts)).toEqual({
      "Date.now": 1,
      "globalThis.Date.now": 1,
      "Date['now']": 1,
      "new Date()": 1,
      "performance.now": 1,
      "process.hrtime": 1,
      "process.hrtime.bigint": 1,
      "process.uptime": 1,
    });
    const vue = `<template><div>{{ x }}</div></template>\n<script setup lang="ts">const x = Date.now();</script>\n<style>.a { color: red }</style>`;
    expect(countClockReads("x.vue", vue)).toEqual({ "Date.now": 1 });
    expect(countClockReads("x.mjs", "export const t = Date.now();")).toEqual({ "Date.now": 1 });
  });

  it("the production file set excludes tests, test helpers, the one clock and the deploy tooling", () => {
    const files = productionFiles(ROOT);
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
    expect(files).not.toContain("src/core/trace/clock.ts");
    expect(files.some((f) => f.startsWith("src/core/testing/"))).toBe(false);
    expect(files).toContain("src/core/dispatcher.ts");
  });

  it("the allowlist matches the tree exactly: no file grew, no listed file has fewer reads than recorded (regenerate with `npm run clock:gen` when a read is removed)", () => {
    const listed = JSON.parse(readFileSync(join(ROOT, ALLOWLIST_PATH), "utf8")) as Allowlist;
    const current = scan(ROOT);
    expect(allowlistProblems(current, listed)).toEqual([]);
    expect(current).toEqual(listed);
    // the problem report names both directions
    expect(allowlistProblems({ "a.ts": 2 }, { "a.ts": 1, "b.ts": 1 })).toEqual([
      "a.ts: 2 clock read(s), allowlist permits 1",
      "b.ts: allowlist says 1 but 0 remain — shrink the entry",
    ]);
  });
});
