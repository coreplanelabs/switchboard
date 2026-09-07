#!/usr/bin/env node
// Deploy preflight for the bot Worker (features/slack-channel.md item 8).
//
// `wrangler deploy` rolls the bot container. Cloudflare's rollout sends SIGTERM
// and allows up to 15 min for the graceful drain (src/index.ts), which is why
// ONE deploy on top of a run finishes the run first. But a SECOND deploy while
// that instance is still draining replaces it immediately: live 2026-08-29,
// deploys at 23:49:45Z and 23:51:15Z landed on a review started 23:48:40Z; the
// run was killed at 153 s, its status card froze forever ("153s — thinking")
// and it vanished from /runs (the registry is in-memory). So `npm run deploy`
// runs this first and refuses while
//   - the bot reports runs in flight (`GET /healthz` → `inFlight > 0`),
//   - the bot is already draining from an earlier rollout (`draining: true`),
//   - the container application is not in a settled state (a rollout is still
//     provisioning/updating — `wrangler containers list --json`).
// It also WARNS (never refuses — this deploy may be the fix) when /healthz
// says the reconnect catch-up is failing or the bot token lacks required
// scopes (#271; `catchUp.error`, `catchUp.missingScopes`).
//
// Fail closed: unreachable bot, a body without the JSON shape (a Worker that
// predates this preflight answers a bare `ok`), a wrangler failure, or an app
// not in the listing all refuse — a deploy never proceeds blind.
// `SWITCHBOARD_DEPLOY_FORCE=1` (or `--force` when run directly) is the
// explicit, warned bypass.
//
// Dependency-free Node (fetch + child_process). `decide()` is pure and
// unit-tested (preflight.test.mjs); `main()` only does I/O around it.
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_BASE_URL = "https://switchboard.coreplanelabs.dev";
/** The Containers application `wrangler deploy` creates for `SwitchboardServer` in wrangler.jsonc. */
export const APP_NAME = "switchboard-switchboardserver";
/** Application states in which no rollout is in progress. Anything else —
 *  `provisioning`, `updating`, or a state this script does not know — refuses. */
const SETTLED_APP_STATES = new Set(["active", "ready"]);

const HOW_TO_FORCE =
  "to deploy anyway (this WILL kill in-flight runs and freeze their status cards): `SWITCHBOARD_DEPLOY_FORCE=1 npm run deploy` (`node preflight.mjs --force` checks alone)";

/** GET /healthz. Never throws: `{ok:true,payload}` (parsed JSON, or the raw text when not JSON) or `{ok:false,error}`. */
export async function fetchHealth(baseUrl, { timeoutMs = 20_000 } = {}) {
  const url = new URL("/healthz", baseUrl).toString();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `GET ${url} → HTTP ${res.status}: ${text.slice(0, 200)}` };
    try {
      return { ok: true, payload: JSON.parse(text) };
    } catch {
      return { ok: true, payload: text };
    }
  } catch (err) {
    return { ok: false, error: `GET ${url} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** `wrangler containers list --json`, run from this directory so wrangler.jsonc
 *  selects the account. Never throws: `{ok:true,payload}` or `{ok:false,error}`. */
export function listContainerApps({ cwd = dirname(fileURLToPath(import.meta.url)), timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["wrangler", "containers", "list", "--json"],
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err)
          return resolve({
            ok: false,
            error: `wrangler containers list failed: ${err.message} ${String(stderr).slice(0, 200)}`.trim(),
          });
        // wrangler prints its banner before the JSON; the payload starts at the first `[`.
        const start = String(stdout).indexOf("[");
        if (start < 0)
          return resolve({
            ok: false,
            error: `wrangler containers list: no JSON array in output: ${String(stdout).slice(0, 200)}`,
          });
        try {
          resolve({ ok: true, payload: JSON.parse(String(stdout).slice(start)) });
        } catch (parseErr) {
          resolve({
            ok: false,
            error: `wrangler containers list: unparsable JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          });
        }
      },
    );
  });
}

/**
 * Warnings (never refusals) from the reconnect catch-up's status on /healthz
 * (#271, features/slack-channel.md item 7): a scan that could not run at all
 * (`catchUp.error`, e.g. `missing_scope`) or a bot token missing required
 * scopes. Pure; an older payload without `catchUp` says nothing.
 * @returns {string[]}
 */
export function catchUpWarnings(payload) {
  const c = payload && typeof payload === "object" ? payload.catchUp : undefined;
  if (!c || typeof c !== "object") return [];
  const out = [];
  if (typeof c.error === "string" && c.error) {
    out.push(
      `reconnect catch-up is NOT running (last attempt${c.lastRunAt ? ` ${c.lastRunAt}` : ""}): ${c.error} — mentions posted during a rollover are being dropped`,
    );
  }
  if (Array.isArray(c.missingScopes) && c.missingScopes.length > 0) {
    out.push(
      `bot token is missing required Slack scopes: ${c.missingScopes.join(", ")} — reinstall the app with them (README → Slack app setup)`,
    );
  }
  return out;
}

/**
 * The decision, pure. `health` is the result of `fetchHealth`, `apps` of `listContainerApps`.
 * `warnings` never block: this deploy may be the fix for what they name.
 * @returns {{ allow: boolean, forced: boolean, problems: string[], warnings: string[], message: string }}
 */
export function decide({ health, apps }, { force = false } = {}) {
  const problems = [];
  const warnings = health?.ok === true ? catchUpWarnings(health.payload) : [];
  const warningText =
    warnings.length > 0
      ? `\n  WARNING (not blocking — deploy may be the fix):\n${warnings.map((w) => `  - ${w}`).join("\n")}`
      : "";

  if (!health || health.ok !== true) {
    problems.push(`bot not consulted: ${health?.error ?? "unknown error"}`);
  } else {
    const p = health.payload;
    if (!p || typeof p !== "object") {
      problems.push(
        `bot answered /healthz without JSON (${JSON.stringify(p).slice(0, 40)}) — the running Worker predates the preflight; deploy once with SWITCHBOARD_DEPLOY_FORCE=1`,
      );
    } else {
      if (!Number.isInteger(p.inFlight) || p.inFlight < 0) {
        problems.push(`bot reports an impossible inFlight=${JSON.stringify(p.inFlight)} (counter bug or old Worker)`);
      } else if (p.inFlight > 0) {
        problems.push(`${p.inFlight} run(s) in flight — a rollout would kill them`);
      }
      if (p.draining === true) {
        problems.push(
          "bot is already draining from a previous deploy — a second rollout replaces the draining instance at once (the 2026-08-29 incident)",
        );
      }
    }
  }

  if (!apps || apps.ok !== true) {
    problems.push(`container application not consulted: ${apps?.error ?? "unknown error"}`);
  } else {
    const app = Array.isArray(apps.payload) ? apps.payload.find((a) => a?.name === APP_NAME) : undefined;
    if (!app) {
      problems.push(
        `container application ${APP_NAME} not in \`wrangler containers list\` (wrong account, or renamed class?)`,
      );
    } else if (!SETTLED_APP_STATES.has(app.state)) {
      problems.push(`container rollout in progress: state=${app.state} — wait until it is active`);
    }
  }

  if (problems.length === 0) {
    return {
      allow: true,
      forced: false,
      problems,
      warnings,
      message: `preflight ok: no runs in flight, not draining, container application settled${warningText}`,
    };
  }
  const detail = problems.map((p) => `  - ${p}`).join("\n");
  if (force) {
    return {
      allow: true,
      forced: true,
      problems,
      warnings,
      message: `preflight WARNING: deploying by force despite —\n${detail}\n  in-flight runs are SIGTERM-drained — they finish if they can, else are killed at the drain deadline — and their status cards left for the next connect's sweep to close${warningText}`,
    };
  }
  return {
    allow: false,
    forced: false,
    problems,
    warnings,
    message: `preflight REFUSED: a Worker deploy rolls the bot container —\n${detail}\n  wait and retry; ${HOW_TO_FORCE}${warningText}`,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const force = argv.includes("--force") || env.SWITCHBOARD_DEPLOY_FORCE === "1";
  const baseUrl = env.SWITCHBOARD_BASE_URL || DEFAULT_BASE_URL;
  const [health, apps] = await Promise.all([fetchHealth(baseUrl), listContainerApps()]);
  const d = decide({ health, apps }, { force });
  (d.allow && !d.forced && d.warnings.length === 0 ? console.log : console.error)(`[bot-preflight] ${d.message}`);
  return d.allow ? 0 : 1;
}

// Run only when executed directly (`node preflight.mjs`), not when imported by tests.
// pathToFileURL, not `file://${argv[1]}`, so the guard also holds on Windows paths.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
