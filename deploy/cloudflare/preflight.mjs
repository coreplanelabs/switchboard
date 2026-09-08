#!/usr/bin/env node
// Deploy preflight for the bot Worker (features/slack-channel.md item 8).
//
// `wrangler deploy` rolls the bot container. Cloudflare's rollout sends SIGTERM;
// since the run ledger's handoff (features/run-history.md item 39) the bot
// hands every resumable run to the next generation and exits within seconds,
// and the next generation continues the runs under their own cards — so a
// deploy no longer waits on runs, and this preflight no longer refuses for
// them. `npm run deploy` runs it first and refuses only while
//   - the container application is not in a settled state (a rollout is still
//     provisioning/updating — `wrangler containers list --json`): a second
//     rollout on top of one in progress is what killed a review at 153 s on
//     2026-08-29 (deploys at 23:49:45Z and 23:51:15Z on a run started 23:48:40Z).
// It WARNS (never refuses) when the bot reports runs in flight (`inFlight > 0`
// — they hand off) or is already draining (`draining: true` — its resumable
// runs were handed off; a ship pipeline still in flight would be killed), and
// when /healthz says the reconnect catch-up is failing or the bot token lacks
// required scopes (#271; `catchUp.error`, `catchUp.missingScopes`).
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

/** The env var naming this Worker's origin. `deploy all` sets it from the deployment profile; the
 *  preflight has no address of its own (deploy/profile.json is the only place the fleet's hostnames live). */
export const BASE_URL_ENV = "SWITCHBOARD_BASE_URL";
/** The Containers application `wrangler deploy` creates for `SwitchboardServer` in wrangler.jsonc. */
export const APP_NAME = "switchboard-switchboardserver";
/** Application states in which no rollout is in progress. Anything else —
 *  `provisioning`, `updating`, or a state this script does not know — refuses. */
const SETTLED_APP_STATES = new Set(["active", "ready"]);

const HOW_TO_FORCE =
  "to deploy anyway (over a rollout in progress, or blind when the bot cannot be consulted): `SWITCHBOARD_DEPLOY_FORCE=1 npm run deploy` (`node preflight.mjs --force` checks alone)";

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

/**
 * The words to keep from a failed wrangler command. wrangler prints its
 * errors on STDOUT (`✘ [ERROR] A request to the Cloudflare API … failed.
 * Authentication error [code: 10000]`), so a message built from stderr alone
 * says "Command failed: npx wrangler containers list --json" and nothing else
 * — which is exactly what the first CI release deploy showed while its token
 * lacked the Containers scope. Prefer wrangler's own error lines; else the
 * last non-empty lines of both streams; else the exit description. Pure.
 */
/** ANSI colour sequences (ESC `[` … `m`), built from the code point so the regex literal carries no control character. */
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function wranglerFailureText(err, stdout, stderr, { maxLines = 3 } = {}) {
  const lines = `${String(stdout ?? "")}\n${String(stderr ?? "")}`
    .split("\n")
    .map((l) => l.replace(ANSI_SEQUENCE, "").trim())
    .filter((l) => l.length > 0 && !/^npm (ERR|WARN|warn)/i.test(l));
  const errorLines = lines.filter((l) =>
    /\[ERROR\]|✘|error|Authentication|Unauthorized|not authorized|permission/i.test(l),
  );
  const picked = (errorLines.length > 0 ? errorLines : lines).slice(-maxLines);
  const exit =
    err && typeof err.code === "number" ? `exit ${err.code}` : err && err.killed ? "killed (timeout?)" : "failed";
  return picked.length > 0 ? `${exit}: ${picked.join(" | ")}` : `${exit}, no output`;
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
            error: `wrangler containers list failed (${wranglerFailureText(err, stdout, stderr)}) — the credential may lack the Containers scope`,
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
        // Not a refusal since the handoff (run-history item 39): SIGTERM hands
        // every resumable run to the next generation, which continues it.
        warnings.push(
          `${p.inFlight} run(s) in flight — handed to the next generation on SIGTERM (run-history item 39); they continue there under their own cards`,
        );
      }
      if (p.draining === true) {
        warnings.push(
          "bot is already draining from a previous deploy — its resumable runs are handed off; a ship pipeline still in flight would be killed when this rollout replaces the draining instance",
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

  const warningText =
    warnings.length > 0 ? `\n  WARNING (not blocking):\n${warnings.map((w) => `  - ${w}`).join("\n")}` : "";
  if (problems.length === 0) {
    return {
      allow: true,
      forced: false,
      problems,
      warnings,
      message: `preflight ok: container application settled${warningText}`,
    };
  }
  const detail = problems.map((p) => `  - ${p}`).join("\n");
  if (force) {
    return {
      allow: true,
      forced: true,
      problems,
      warnings,
      message: `preflight WARNING: deploying by force despite —\n${detail}\n  a rollout landing on one in progress can disrupt it; in-flight runs hand off regardless (run-history item 39)${warningText}`,
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
  const baseUrl = env[BASE_URL_ENV];
  if (!baseUrl) {
    console.error(
      `[bot-preflight] ${BASE_URL_ENV} is not set — the bot's origin comes from the deployment profile; deploy through \`npm run cli -- deploy all\` (it sets it), or set it to https://<bot hostname> to run this alone`,
    );
    return 2;
  }
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
