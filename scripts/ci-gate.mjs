#!/usr/bin/env node
// The one status check behind a fan-out. The branch ruleset requires the
// checks `bot` and `workers` by name; each is now a matrix of jobs (one per
// static check, one per test shard, one per Worker), and a matrix job's name
// changes with its legs. So the required check is a gate job that `needs:`
// the fan-out, runs `if: always()`, and hands its `needs` context (every
// upstream job's result) to this script through the NEEDS environment
// variable: it passes only when every upstream job succeeded. A skipped or
// cancelled leg fails the gate too — a check the ruleset requires must never
// go green because a job did not run.

import { pathToFileURL } from "node:url";

/** Pure: the upstream jobs that did not succeed, from the `needs` context. */
export function failedJobs(needs) {
  return Object.entries(needs)
    .filter(([, job]) => job?.result !== "success")
    .map(([id, job]) => ({ id, result: job?.result ?? "missing" }));
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
    const failed = failedJobs(needs);
    for (const [id, job] of Object.entries(needs)) console.log(`${id}: ${job?.result ?? "missing"}`);
    if (failed.length > 0) {
      console.error(`ci:gate FAILED — ${failed.map((f) => `${f.id} ${f.result}`).join(", ")}`);
      process.exit(1);
    }
    console.log(`ci:gate ok — ${Object.keys(needs).length} upstream job(s) succeeded`);
  } catch (err) {
    console.error(`ci:gate FAILED — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
