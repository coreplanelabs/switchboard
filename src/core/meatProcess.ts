import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Secret } from "../secrets.js";
import { redactSecrets } from "./runEvents.js";
import { parseMeatJson, type MeatResult } from "./readingDiff.js";
import { safeMeatText } from "./readingDiffProgress.js";

// meat.dev on the BOT host (docs/reference/specs/reading-diff.md items 5–6). The
// abridged reading diff is one child process per production: `meat -json -model
// <m>` with the unified diff on its stdin — meat reads stdin whenever it is not
// a terminal (cmd/meat/main.go) — and exactly four environment variables. The
// binary is spawned HERE and nowhere else (meatProcess.test.ts holds that): one
// environment, one failure vocabulary, one paid model job.
//
// The child's environment is built, not inherited: PATH and HOME so the binary
// resolves and Go's own defaults hold, MEAT_CACHE so meat's result cache (keyed
// by the hash of model + diff, so the same review abridged twice costs one
// job) lives under the bot's data dir, and ANTHROPIC_API_KEY — the bot's own
// credential, read through the one getter the Anthropic provider uses. None of
// the bot's other secrets (Slack, GitHub, the Workers' bearers) reach meat.

/** The binary's name on PATH; the bot image installs it at /usr/local/bin. */
export const MEAT_BINARY = "meat";

/** The host probe behind the `readingDiffAbridge` capability (src/core/capabilities.ts):
 *  does `meat` resolve as an executable on the given PATH — what `command -v
 *  meat` answers, asked once at startup. An unset PATH is a no. */
export function meatOnPath(env: { PATH?: string }, binary = MEAT_BINARY): boolean {
  return (env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "")
    .some((dir) => {
      try {
        accessSync(join(dir, binary), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

/** meat's stderr is kept to this many chars for the failure reason. */
const STDERR_CAP = 4_000;

export interface MeatRun {
  /** The unified diff meat abridges — written whole to its stdin. */
  diff: string;
  model: string;
  /** Progress is delivered in order before the process result settles. */
  onProgress?: (message: string) => void | Promise<void>;
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
 *  missing (`ENOENT`), a nonzero exit (its code + meat's final stderr line),
 *  output that is not meat's JSON. Meat owns its runtime deadline.
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
    const raw = await collect(
      host.binary ?? MEAT_BINARY,
      ["-json", "-model", run.model],
      run.diff,
      env,
      run.onProgress,
    );
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
  onProgress?: MeatRun["onProgress"],
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    let oversizedLine = false;
    let deliveries = Promise.resolve();
    let deliveryError: unknown;
    let deliveryFailed = false;
    const safe = (text: string) => safeMeatText(text.replaceAll(env.ANTHROPIC_API_KEY, "«redacted»"));
    const publish = (line: string) => {
      const message = safe(line);
      if (!message || !onProgress) return;
      deliveries = deliveries
        .then(() => onProgress(message))
        .catch((err: unknown) => {
          deliveryFailed = true;
          deliveryError ??= err;
        });
    };
    let settled = false;
    const finish = (r: { ok: true; stdout: string } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      resolve(r.ok ? r : { ok: false, reason: redactSecrets(r.reason) });
    };
    const child = spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_CAP * 2);
      for (const part of chunk.split(/(?<=\n)/)) {
        pendingLine += part;
        if (pendingLine.length > STDERR_CAP * 2) {
          oversizedLine = true;
          pendingLine = "";
        }
        if (part.endsWith("\n")) {
          publish(oversizedLine ? "meat: oversized progress line omitted" : pendingLine);
          pendingLine = "";
          oversizedLine = false;
        }
      }
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
      if (pendingLine || oversizedLine) publish(oversizedLine ? "meat: oversized progress line omitted" : pendingLine);
      void deliveries.then(() => {
        const last = safe(stderr.trim().split("\n").at(-1) ?? "").slice(0, STDERR_CAP);
        const failure = code === 0 ? undefined : `meat exited ${code ?? signal ?? "?"}${last ? `: ${last}` : ""}`;
        const progressFailure = deliveryFailed
          ? `meat progress could not be stored: ${safe(String(deliveryError))}`
          : undefined;
        if (failure || progressFailure)
          return finish({ ok: false, reason: [failure, progressFailure].filter(Boolean).join("; ") });
        finish({ ok: true, stdout });
      });
    });
    // A closed stdin (the child exited before reading) is not an error of ours.
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}
