#!/usr/bin/env node
// Deploy preflight for the resident Worker (docs/reference/specs/resident-repos.md item 44).
//
// `wrangler deploy` replaces every ResidentDO isolate and invalidates the
// Sandbox SDK process handles held by in-flight runs ("Process handle refers
// to a previous runtime incarnation") — the container-restart deferral in
// `reconcileImage` cannot protect against a Worker deploy. So `npm run deploy`
// runs this first: it asks the live Worker's `GET /residents` for every
// resident's in-flight count and exits non-zero while anything is running.
//
// Fail closed: no bearer, unreachable Worker, or a resident whose live view
// errored all refuse — a deploy never proceeds blind. `RESIDENT_DEPLOY_FORCE=1`
// (or `--force` when run directly) is the explicit, warned bypass.
//
// Dependency-free Node (fetch is built in). `decide()` is pure and unit-tested
// (preflight.test.mjs); `main()` only does I/O around it.

import { pathToFileURL } from "node:url";

/** The env var naming this Worker's origin. `deploy all` sets it from the deployment profile; the
 *  preflight has no address of its own (deploy/profile.json is the only place the fleet's hostnames live). */
export const BASE_URL_ENV = "RESIDENT_BASE_URL";
export const TOKEN_ENV_VARS = ["RESIDENT_ADMIN_TOKEN", "RESIDENT_OPERATOR_TOKEN", "RESIDENT_READ_TOKEN"];

const HOW_TO_SET_TOKEN =
  `set one of ${TOKEN_ENV_VARS.join(" / ")} in the environment (the same bearer ` +
  "`npm run secrets` put on the Worker; any scope may read /residents), e.g. " +
  "`RESIDENT_ADMIN_TOKEN=… npm run deploy`";
const HOW_TO_FORCE =
  "to deploy anyway (this WILL kill in-flight runs): `RESIDENT_DEPLOY_FORCE=1 npm run deploy` (`node preflight.mjs --force` checks alone)";
/** Lifecycle states in which NOTHING is executing on the resident — the only
 *  states a deploy may land on. Every other state is either known mid-cycle
 *  (the engine is running a refresh's fetch/rebuild, a restore, or
 *  provisioning — an isolate swap kills that like a thread run) or a
 *  state this script does not know, which fails closed as `unknown`: this is
 *  plain JS outside the shared `ResidentLifecycleState` type, so an allow-list
 *  of settled states is what keeps vocabulary drift from silently allowing. */
const SETTLED_STATES = new Set(["warm", "degraded", "down"]);
/** The engine is executing and an isolate swap would FAIL it: provisioning
 *  (`onboarding`) has no checkpoint to resume from — a killed install or build
 *  is `provision-failed`, `down`, and only a rebuild recovers it. */
const PROVISIONING_STATES = new Set(["onboarding"]);
/** The engine is executing and an isolate swap merely INTERRUPTS it: a refresh
 *  step is retried by its Workflow instance and resumes from its disk
 *  checkpoints (resident-repos items 44 and 48); a restore is retried by the next hydrate, which first
 *  unmounts and removes whatever the interrupted one left (item 61). These
 *  used to refuse like `onboarding`, and a release deploy once spent its whole
 *  budget behind a resident stuck in `restoring` — a state an isolate swap
 *  would have HELPED. Allowed with a warning. */
const INTERRUPTIBLE_STATES = new Set(["refreshing", "restoring"]);

/** First present, non-blank bearer in preference order; null when none. */
export function readToken(env) {
  for (const name of TOKEN_ENV_VARS) {
    const v = env[name];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

/** GET /residents. Never throws: `{ok:true,payload}` or `{ok:false,error}`. */
export async function fetchResidents(baseUrl, token, { timeoutMs = 15_000 } = {}) {
  if (!token) return { ok: false, error: "no bearer in the environment" };
  const url = new URL("/residents", baseUrl).toString();
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `GET ${url} → HTTP ${res.status}: ${text.slice(0, 200)}` };
    try {
      return { ok: true, payload: JSON.parse(text) };
    } catch {
      return { ok: false, error: `GET ${url} → non-JSON body: ${text.slice(0, 200)}` };
    }
  } catch (err) {
    return { ok: false, error: `GET ${url} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The decision, pure. `fetched` is the result of `fetchResidents`.
 * @returns {{ allow: boolean, forced: boolean, busy: {resource:string,inFlight:number}[], provisioning: {resource:string,state:string}[], interrupting: {resource:string,state:string}[], unknown: {resource:string,error:string}[], message: string }}
 */
export function decide(fetched, { force = false } = {}) {
  const busy = [];
  const provisioning = [];
  const interrupting = [];
  const unknown = [];
  const problems = [];

  if (!fetched || fetched.ok !== true) {
    problems.push(`resident Worker not consulted: ${fetched?.error ?? "unknown error"}`);
  } else {
    const residents = fetched.payload?.residents;
    if (!Array.isArray(residents)) {
      problems.push("resident Worker answered without a `residents` array (malformed /residents payload)");
    } else {
      for (const r of residents) {
        const resource = typeof r?.resource === "string" ? r.resource : "<unnamed resident>";
        const live = r?.live;
        if (!live || typeof live !== "object" || typeof live.error === "string") {
          unknown.push({ resource, error: live?.error ?? "no live view" });
        } else if (typeof live.inFlight !== "number") {
          unknown.push({
            resource,
            error:
              "live view carries no inFlight count (Worker predates the preflight — deploy once with RESIDENT_DEPLOY_FORCE=1)",
          });
        } else if (!Number.isInteger(live.inFlight) || live.inFlight < 0) {
          // A count that is not a non-negative integer can only come from a
          // counter bug (double release, unmatched decrement). We cannot tell
          // idle from busy, so it is unknown — never an implicit "0 busy".
          unknown.push({ resource, error: `live view carries an impossible inFlight=${live.inFlight} (counter bug)` });
        } else if (
          live.runsInFlight !== undefined &&
          (typeof live.runsInFlight !== "number" || !Number.isInteger(live.runsInFlight) || live.runsInFlight < 0)
        ) {
          unknown.push({
            resource,
            error: `live view carries an impossible runsInFlight=${live.runsInFlight} (counter bug)`,
          });
        } else {
          // `inFlight` counts the refresh cycle itself along with the runs, so a
          // resident that is merely refreshing reads ≥ 1. The busy decision is
          // about what a swap kills for a USER — the runs — which a Worker since
          // item 44's revision reports apart as `runsInFlight`; an older Worker
          // without the field is judged on `inFlight` as before (over-refusing,
          // never under). Runs and cycles are independent facts; report BOTH so
          // an operator who waits for the runs is not surprised by a second refusal.
          const runs = typeof live.runsInFlight === "number" ? live.runsInFlight : live.inFlight;
          if (runs > 0) busy.push({ resource, inFlight: runs });
          if (PROVISIONING_STATES.has(live.state)) {
            // Provisioning is mid-flight. An isolate swap kills it just like a
            // thread run (seen live: `build-failed: exit 143: Session
            // terminated` right after a deploy that passed the inFlight
            // check), and unlike a refresh it cannot resume.
            provisioning.push({ resource, state: live.state });
          } else if (INTERRUPTIBLE_STATES.has(live.state)) {
            interrupting.push({ resource, state: live.state });
          } else if (!SETTLED_STATES.has(live.state)) {
            // A state this script does not know: fail closed rather than assume settled.
            unknown.push({
              resource,
              error: `live view carries an unrecognized state ${JSON.stringify(live.state)} (vocabulary drift — update preflight.mjs)`,
            });
          }
        }
      }
      if (busy.length)
        problems.push(`in flight: ${busy.map((b) => `${b.resource} (${b.inFlight} in flight)`).join(", ")}`);
      if (provisioning.length)
        problems.push(
          `provisioning: ${provisioning.map((m) => `${m.resource} (${m.state})`).join(", ")} — the provision would be killed and only a rebuild recovers it`,
        );
      if (unknown.length)
        problems.push(`unknown state: ${unknown.map((u) => `${u.resource} (${u.error})`).join(", ")}`);
    }
  }

  // Interruptible cycles never refuse; they are named so the log says what the
  // swap interrupts and why that is fine.
  const warningText = interrupting.length
    ? ` — WARNING: mid-cycle: ${interrupting.map((m) => `${m.resource} (${m.state})`).join(", ")} — the isolate swap interrupts it; the refresh instance retries the step from its checkpoints, a restore is retried by the next hydrate (resident-repos items 44/61)`
    : "";

  if (problems.length === 0) {
    const count = fetched.payload.residents.length;
    return {
      allow: true,
      forced: false,
      busy,
      provisioning,
      interrupting,
      unknown,
      message: `preflight ok: ${count} residents, no resident has work in flight or a provision running${warningText}`,
    };
  }
  const detail = problems.map((p) => `  - ${p}`).join("\n");
  if (force) {
    return {
      allow: true,
      forced: true,
      busy,
      provisioning,
      interrupting,
      unknown,
      message: `preflight WARNING: deploying by force despite —\n${detail}\n  in-flight runs and provisions on the residents above WILL be killed (process handles invalidated by the isolate swap)${warningText}`,
    };
  }
  const hints = [HOW_TO_FORCE];
  if (fetched?.ok !== true) hints.unshift(HOW_TO_SET_TOKEN);
  return {
    allow: false,
    forced: false,
    busy,
    provisioning,
    interrupting,
    unknown,
    message: `preflight REFUSED: a Worker deploy swaps every ResidentDO isolate and kills in-flight runs and provisions —\n${detail}\n  wait for them to finish and retry; ${hints.join("; ")}${warningText}`,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const force = argv.includes("--force") || env.RESIDENT_DEPLOY_FORCE === "1";
  const baseUrl = env[BASE_URL_ENV];
  if (!baseUrl) {
    console.error(
      `[resident-preflight] ${BASE_URL_ENV} is not set — the resident Worker's origin comes from the deployment profile; deploy through \`npm run cli -- deploy all\` (it sets it), or set it to https://<resident hostname> to run this alone`,
    );
    return 2;
  }
  const fetched = await fetchResidents(baseUrl, readToken(env));
  const d = decide(fetched, { force });
  (d.allow && !d.forced ? console.log : console.error)(`[resident-preflight] ${d.message}`);
  return d.allow ? 0 : 1;
}

// Run only when executed directly (`node preflight.mjs`), not when imported by tests.
// pathToFileURL, not `file://${argv[1]}`, so the guard also holds on Windows paths.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
