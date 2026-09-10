import { spawn } from "node:child_process";
import type { Secret } from "../secrets.js";
import { redactSecrets } from "./runEvents.js";
import { parseMeatJson, type MeatResult } from "./readingDiff.js";

// meat.dev on the BOT host (docs/reference/specs/reading-diff.md items 5–6). The
// abridged reading diff is one child process per production: `meat -json -model
// <m>` with the unified diff on its stdin — meat reads stdin whenever it is not
// a terminal (cmd/meat/main.go) — and exactly four environment variables. The
// binary is spawned HERE and nowhere else (meatProcess.test.ts holds that): one
// environment, one failure vocabulary, one way to spend an Opus call.
//
// The child's environment is built, not inherited: PATH and HOME so the binary
// resolves and Go's own defaults hold, MEAT_CACHE so meat's result cache (keyed
// by the hash of model + diff, so the same review abridged twice costs one
// call) lives under the bot's data dir, and ANTHROPIC_API_KEY — the bot's own
// credential, read through the one getter the Anthropic provider uses. None of
// the bot's other secrets (Slack, GitHub, the Workers' bearers) reach meat.

/** The binary's name on PATH; the bot image installs it at /usr/local/bin. */
export const MEAT_BINARY = "meat";

/** meat's `-model` when config names none: an Opus-class model, the measured
 *  minimum for a diff that is actually abridged (readingDiff.ts). */
export const MEAT_MODEL_DEFAULT = "claude-opus-5";

/** meat's stderr is kept to this many chars for the failure reason. */
const STDERR_CAP = 4_000;

export interface MeatRun {
  /** The unified diff meat abridges — written whole to its stdin. */
  diff: string;
  model: string;
  /** meat's budget; past it the child is killed and the run fails by name. */
  timeoutMs: number;
}

export type MeatRunResult = { ok: true; result: MeatResult } | { ok: false; reason: string };

export interface MeatHost {
  /** The Anthropic credential meat spends: `anthropicApiKey(config.providers,
   *  secrets)` in production — a `Secret`, revealed here and only into the
   *  child's environment. Undefined refuses before any spawn — meat would only
   *  fail later with its own wording. */
  apiKey: () => Secret | undefined;
  /** `MEAT_CACHE`: meat's result cache directory (`<dataDir>/meat-cache`). */
  cacheDir: string;
  /** The two host variables the child inherits; nothing else of the host env. */
  hostEnv: { PATH?: string; HOME?: string };
  /** The executable; default `meat` on PATH (tests point at a fake). */
  binary?: string;
}

/** A runner over one host: `(run) → the parsed result or a named failure`,
 *  never a throw. Failures: no credential (before the spawn), the binary
 *  missing (`ENOENT`), a nonzero exit (its code + meat's first stderr line),
 *  output that is not meat's JSON, the budget passing (the child is killed).
 *  Every reason is redacted — stderr is remote-shaped text. */
export function meatOnHost(host: MeatHost): (run: MeatRun) => Promise<MeatRunResult> {
  return async (run) => {
    const key = host.apiKey();
    if (!key) return { ok: false, reason: "no Anthropic credential: the bot's Anthropic provider has no API key" };
    const env: Record<string, string> = {
      ...(host.hostEnv.PATH !== undefined ? { PATH: host.hostEnv.PATH } : {}),
      ...(host.hostEnv.HOME !== undefined ? { HOME: host.hostEnv.HOME } : {}),
      MEAT_CACHE: host.cacheDir,
      // The one boundary the key crosses: the child process's environment.
      ANTHROPIC_API_KEY: key.reveal(),
    };
    const raw = await collect(host.binary ?? MEAT_BINARY, ["-json", "-model", run.model], run.diff, env, run.timeoutMs);
    if (!raw.ok) return raw;
    try {
      return { ok: true, result: parseMeatJson(raw.stdout) };
    } catch (err) {
      return { ok: false, reason: redactSecrets(err instanceof Error ? err.message : String(err)) };
    }
  };
}

function collect(
  binary: string,
  args: string[],
  stdin: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: { ok: true; stdout: string } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r.ok ? r : { ok: false, reason: redactSecrets(r.reason) });
    };
    const child = spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, reason: `meat did not finish within ${timeoutMs / 1000}s` });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.slice(0, STDERR_CAP - stderr.length);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        reason:
          err.code === "ENOENT"
            ? `meat is not installed on this host (${binary}: ENOENT)`
            : `meat could not be started: ${err.message}`,
      });
    });
    child.on("close", (code, signal) => {
      if (code === 0) return finish({ ok: true, stdout });
      const first = stderr.trim().split("\n", 1)[0] ?? "";
      finish({ ok: false, reason: `meat exited ${code ?? signal ?? "?"}${first ? `: ${first}` : ""}` });
    });
    // A closed stdin (the child exited before reading) is not an error of ours.
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}
