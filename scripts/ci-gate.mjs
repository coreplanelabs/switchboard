#!/usr/bin/env node
// The one status check behind a fan-out. The branch ruleset requires the
// checks `bot`, `workers` and `image` by name; each is now a matrix of jobs (one per
// static check, one per test shard, one per Worker), and a matrix job's name
// changes with its legs. So the required check is a gate job that `needs:`
// the fan-out, runs `if: always()`, and hands its `needs` context (every
// upstream job's result) to this script through the NEEDS environment
// variable. A skipped leg passes only when the successful change plan
// explicitly omitted it; a cancelled or failed leg always fails the gate.

import { pathToFileURL } from "node:url";

/** Pure: the upstream jobs that did not succeed, from the `needs` context. */
export function failedJobs(needs, allowedSkipped = []) {
  return Object.entries(needs)
    .filter(([id, job]) => job?.result !== "success" && !(job?.result === "skipped" && allowedSkipped.includes(id)))
    .map(([id, job]) => ({ id, result: job?.result ?? "missing" }));
}

/** A successful plan may omit these fan-outs; no other skip is intentional. */
export function plannedSkips(needs) {
  if (needs.plan?.result !== "success") return [];
  const outputs = needs.plan.outputs ?? {};
  return [
    outputs.bot_tests === "false" && "bot-tests",
    outputs.workers === '["none"]' && "workers-each",
    outputs.images === '["none"]' && "image-each",
  ].filter(Boolean);
}

/** Parse the NEEDS value; anything but a non-empty JSON object is a failure. */
export function parseNeeds(raw) {
  if (!raw) throw new Error("NEEDS is unset — the gate job must pass `env: NEEDS: ${{ toJSON(needs) }}`");
  const needs = JSON.parse(raw);
  if (typeof needs !== "object" || needs === null || Array.isArray(needs) || Object.keys(needs).length === 0) {
    throw new Error("NEEDS holds no jobs — the gate must `needs:` the fan-out it stands for");
  }
  return needs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const needs = parseNeeds(process.env.NEEDS);
    const failed = failedJobs(needs, plannedSkips(needs));
    for (const [id, job] of Object.entries(needs)) console.log(`${id}: ${job?.result ?? "missing"}`);
    if (failed.length > 0) {
      console.error(`ci:gate FAILED — ${failed.map((f) => `${f.id} ${f.result}`).join(", ")}`);
      process.exit(1);
    }
    const succeeded = Object.values(needs).filter((job) => job?.result === "success").length;
    const skipped = Object.values(needs).filter((job) => job?.result === "skipped").length;
    console.log(`ci:gate ok — ${succeeded} upstream job(s) succeeded${skipped ? `, ${skipped} planned skip(s)` : ""}`);
  } catch (err) {
    console.error(`ci:gate FAILED — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
