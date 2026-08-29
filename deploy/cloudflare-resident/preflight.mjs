#!/usr/bin/env node
// Deploy preflight for the resident Worker (features/resident-repos.md item 44).
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

export const DEFAULT_BASE_URL = "https://switchboard-resident.coreplanelabs.dev";
export const TOKEN_ENV_VARS = ["RESIDENT_ADMIN_TOKEN", "RESIDENT_OPERATOR_TOKEN", "RESIDENT_READ_TOKEN"];

const HOW_TO_SET_TOKEN =
  `set one of ${TOKEN_ENV_VARS.join(" / ")} in the environment (the same bearer ` +
  "`npm run secrets` put on the Worker; any scope may read /residents), e.g. " +
  "`RESIDENT_ADMIN_TOKEN=… npm run deploy`";
const HOW_TO_FORCE = "to deploy anyway (this WILL kill in-flight runs): `RESIDENT_DEPLOY_FORCE=1 npm run deploy` (`node preflight.mjs --force` checks alone)";

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
 * @returns {{ allow: boolean, forced: boolean, busy: {resource:string,inFlight:number}[], unknown: {resource:string,error:string}[], message: string }}
 */
export function decide(fetched, { force = false } = {}) {
  const busy = [];
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
          unknown.push({ resource, error: "live view carries no inFlight count (Worker predates the preflight — deploy once with RESIDENT_DEPLOY_FORCE=1)" });
        } else if (!Number.isInteger(live.inFlight) || live.inFlight < 0) {
          // A count that is not a non-negative integer can only come from a
          // counter bug (double release, unmatched decrement). We cannot tell
          // idle from busy, so it is unknown — never an implicit "0 busy".
          unknown.push({ resource, error: `live view carries an impossible inFlight=${live.inFlight} (counter bug)` });
        } else if (live.inFlight > 0) {
          busy.push({ resource, inFlight: live.inFlight });
        }
      }
      if (busy.length) problems.push(`in flight: ${busy.map((b) => `${b.resource} (${b.inFlight} in flight)`).join(", ")}`);
      if (unknown.length) problems.push(`unknown state: ${unknown.map((u) => `${u.resource} (${u.error})`).join(", ")}`);
    }
  }

  if (problems.length === 0) {
    const count = fetched.payload.residents.length;
    return { allow: true, forced: false, busy, unknown, message: `preflight ok: ${count} residents, no resident has work in flight` };
  }
  const detail = problems.map((p) => `  - ${p}`).join("\n");
  if (force) {
    return {
      allow: true,
      forced: true,
      busy,
      unknown,
      message: `preflight WARNING: deploying by force despite —\n${detail}\n  in-flight runs on the residents above WILL be killed (process handles invalidated by the isolate swap)`,
    };
  }
  const hints = [HOW_TO_FORCE];
  if (fetched?.ok !== true) hints.unshift(HOW_TO_SET_TOKEN);
  return {
    allow: false,
    forced: false,
    busy,
    unknown,
    message: `preflight REFUSED: a Worker deploy swaps every ResidentDO isolate and kills in-flight runs —\n${detail}\n  wait for the runs to finish and retry; ${hints.join("; ")}`,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const force = argv.includes("--force") || env.RESIDENT_DEPLOY_FORCE === "1";
  const baseUrl = env.RESIDENT_BASE_URL || DEFAULT_BASE_URL;
  const fetched = await fetchResidents(baseUrl, readToken(env));
  const d = decide(fetched, { force });
  (d.allow && !d.forced ? console.log : console.error)(`[resident-preflight] ${d.message}`);
  return d.allow ? 0 : 1;
}

// Run only when executed directly (`node preflight.mjs`), not when imported by tests.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await main();
}
