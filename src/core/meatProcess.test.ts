import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Secret } from "../secrets.js";
import { MEAT_BINARY, meatOnHost, meatOnPath, type MeatHost } from "./meatProcess.js";

// Feature: docs/reference/specs/reading-diff.md item 6 — meat runs in the BOT
// process over a unified diff on its stdin, with exactly the environment the
// runner hands it: PATH and HOME from the host, MEAT_CACHE, and the bot's own
// Anthropic credential. A fake `meat` on a private PATH stands in for the real
// binary: it echoes what it received so the test can see the contract from the
// child's side. Nothing here reaches the network.

const SRC = resolve(import.meta.dirname, "..");

/** A directory holding an executable `meat` whose body is `script` (POSIX sh). */
function fakeMeat(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "swb-fake-meat-"));
  const path = join(dir, MEAT_BINARY);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return dir;
}

/** The JSON-emitting fake: summary = the stdin byte count, elision = the env
 *  names it saw (sorted), so the caller's contract is visible in the result. */
const ECHO_JSON = [
  'input=$(cat); n=$(printf %s "$input" | wc -c | tr -d " ")',
  'names=$(env | cut -d= -f1 | sort | tr "\\n" ",")',
  'printf \'{"smart_diff":"abridged %s","summary":"bytes=%s model=%s","input_tokens":11,"output_tokens":3,"elision":"%s"}\' "$MEAT_CACHE" "$n" "$3" "$names"',
].join("\n");

function host(dir: string, over: Partial<MeatHost> = {}): MeatHost {
  return {
    apiKey: () => new Secret("sk-ant-test-key", "ANTHROPIC_API_KEY"),
    cacheDir: "/var/tmp/meat-cache",
    // The fake resolves first; the host's PATH follows so the fake's own `cat`/`wc`/`env` resolve too.
    hostEnv: { PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: "/home/bot" },
    ...over,
  };
}

const DIFF = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";

describe("meatOnHost", () => {
  it("does not kill a running meat process when four minutes pass", async () => {
    const dir = fakeMeat('while [ ! -f "$0.release" ]; do sleep 0.01; done; ' + ECHO_JSON);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const result = meatOnHost(host(dir))({ diff: DIFF, model: "m" });
      await vi.advanceTimersByTimeAsync(240_001);
      writeFileSync(join(dir, "meat.release"), "continue");
      expect(await result).toMatchObject({
        ok: true,
        result: { summary: `bytes=${Buffer.byteLength(DIFF) - 1} model=m` },
      });
    } finally {
      writeFileSync(join(dir, "meat.release"), "continue");
      vi.useRealTimers();
    }
  });

  it("lets meat report its own deadline and retains progress before the final error", async () => {
    const dir = fakeMeat(
      'printf "meat: thinking (turn 1)\\n" >&2; sleep 0.05; printf "meat: model generate: context deadline exceeded\\n" >&2; exit 1',
    );
    const progress: string[] = [];
    const result = await meatOnHost(host(dir))({
      diff: DIFF,
      model: "m",
      onProgress: (message: string) => {
        progress.push(message);
      },
    });
    expect(result).toEqual({ ok: false, reason: "meat exited 1: meat: model generate: context deadline exceeded" });
    expect(progress).toEqual(["meat: thinking (turn 1)", "meat: model generate: context deadline exceeded"]);
  });

  it("publishes complete stderr lines before exit, including split chunks and a final line without a newline", async () => {
    const dir = fakeMeat(
      'printf "meat: think" >&2; sleep 0.01; printf "ing (turn 1)\\n" >&2; while [ ! -f "$0.release" ]; do sleep 0.01; done; printf "meat: finished" >&2; ' +
        ECHO_JSON,
    );
    const progress: string[] = [];
    const result = await meatOnHost(host(dir))({
      diff: DIFF,
      model: "m",
      onProgress: (message: string) => {
        progress.push(message);
        writeFileSync(join(dir, "meat.release"), "continue");
      },
    });
    expect(result).toMatchObject({ ok: true, result: { summary: `bytes=${Buffer.byteLength(DIFF) - 1} model=m` } });
    expect(progress).toEqual(["meat: thinking (turn 1)", "meat: finished"]);
  });
  it("pipes the diff on stdin, passes -json -model <m>, and returns the parsed result", async () => {
    const dir = fakeMeat(ECHO_JSON);
    const r = await meatOnHost(host(dir))({ diff: DIFF, model: "claude-opus-5" });
    expect(r).toEqual({
      ok: true,
      result: {
        diff: "abridged /var/tmp/meat-cache",
        // `$(cat)` in the fake drops the diff's trailing newline; the child still read the whole diff.
        summary: `bytes=${Buffer.byteLength(DIFF) - 1} model=claude-opus-5`,
        inputTokens: 11,
        outputTokens: 3,
      },
    });
  });

  it("hands the child exactly PATH, HOME, MEAT_CACHE and ANTHROPIC_API_KEY — none of the host's other variables", async () => {
    const dir = fakeMeat('env | cut -d= -f1 | sort | tr "\\n" "," > "$0.env"; ' + ECHO_JSON);
    await meatOnHost(host(dir))({ diff: DIFF, model: "m" });
    const seen = readFileSync(join(dir, `${MEAT_BINARY}.env`), "utf8")
      .split(",")
      .filter(Boolean);
    // `_` and PWD are the shell's own; everything else must be ours.
    expect(seen.filter((n) => n !== "_" && n !== "PWD" && n !== "SHLVL")).toEqual(
      ["ANTHROPIC_API_KEY", "HOME", "MEAT_CACHE", "PATH"].sort(),
    );
    expect(readdirSync(dir)).toContain(`${MEAT_BINARY}.env`);
  });

  it("refuses before any spawn when the bot holds no Anthropic credential", async () => {
    const dir = fakeMeat('echo spawned > "$0.ran"; ' + ECHO_JSON);
    const r = await meatOnHost(host(dir, { apiKey: () => undefined }))({ diff: DIFF, model: "m" });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/no Anthropic credential/) });
    expect(readdirSync(dir)).not.toContain(`${MEAT_BINARY}.ran`);
  });

  it("a missing binary is a named failure, never a throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swb-no-meat-"));
    const r = await meatOnHost(host(dir))({ diff: DIFF, model: "m" });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/meat is not installed/) });
  });

  it("a nonzero exit names the code and meat's first stderr line", async () => {
    const dir = fakeMeat('echo "meat: no LLM credentials: set ANTHROPIC_API_KEY" >&2; exit 1');
    const r = await meatOnHost(host(dir))({ diff: DIFF, model: "m" });
    expect(r).toEqual({ ok: false, reason: "meat exited 1: meat: no LLM credentials: set ANTHROPIC_API_KEY" });
  });

  it("output that is not meat's JSON is a named failure", async () => {
    const dir = fakeMeat("echo not json at all");
    const r = await meatOnHost(host(dir))({ diff: DIFF, model: "m" });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/not JSON/) });
  });

  it("a stderr line carrying a credential is redacted in the reason", async () => {
    const dir = fakeMeat(`echo "bad key ghp_${"A".repeat(36)}" >&2; exit 2`);
    const r = await meatOnHost(host(dir))({ diff: DIFF, model: "m" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toMatch(/ghp_A{36}/);
      expect(r.reason).toContain("«redacted");
    }
  });
});

// The host fact behind the `readingDiffAbridge` capability: `command -v meat`, asked once.
describe("meatOnPath", () => {
  it("is true when an executable meat is in a PATH entry, false for a non-executable, an empty PATH, or none", () => {
    const withMeat = fakeMeat("exit 0");
    const without = mkdtempSync(join(tmpdir(), "swb-no-meat-"));
    const notExecutable = mkdtempSync(join(tmpdir(), "swb-meat-noexec-"));
    writeFileSync(join(notExecutable, MEAT_BINARY), "#!/bin/sh\n");
    chmodSync(join(notExecutable, MEAT_BINARY), 0o644);
    expect(meatOnPath({ PATH: `${without}:${withMeat}` })).toBe(true);
    expect(meatOnPath({ PATH: without })).toBe(false);
    expect(meatOnPath({ PATH: notExecutable })).toBe(false);
    expect(meatOnPath({ PATH: "" })).toBe(false);
    expect(meatOnPath({})).toBe(false);
  });
});

// ONE abridge path (docs/reference/specs/reading-diff.md item 5): the binary is
// spawned in exactly one module. A second spawn site would be a second way to
// spend an Opus call, with its own environment and its own failure wording.
describe("meat is spawned in one module", () => {
  it("no other source file names the binary as a child process", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !path.endsWith("meatProcess.ts")) {
          const text = readFileSync(path, "utf8");
          if (/\b(spawn|execFile|exec)\(\s*(MEAT_BINARY|["'`]meat["'`])/.test(text)) offenders.push(path);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});

describe("meat progress failures", () => {
  it("reports a progress write failure even when meat returns valid JSON", async () => {
    const dir = fakeMeat('printf "meat: thinking (turn 1)\\n" >&2; ' + ECHO_JSON);
    const result = await meatOnHost(host(dir))({
      diff: DIFF,
      model: "m",
      onProgress: async () => {
        throw new Error("history unavailable");
      },
    });
    expect(result).toEqual({ ok: false, reason: "meat progress could not be stored: Error: history unavailable" });
    const failed = fakeMeat('printf "meat: provider unavailable\\n" >&2; exit 1');
    expect(
      await meatOnHost(host(failed))({
        diff: DIFF,
        model: "m",
        onProgress: async () => {
          throw new Error("history unavailable");
        },
      }),
    ).toEqual({
      ok: false,
      reason:
        "meat exited 1: meat: provider unavailable; meat progress could not be stored: Error: history unavailable",
    });
  });

  it("redacts the actual credential before progress reaches its observer", async () => {
    const dir = fakeMeat('printf "bad credential %s\\n" "$ANTHROPIC_API_KEY" >&2; exit 1');
    const progress: string[] = [];
    const result = await meatOnHost(host(dir))({
      diff: DIFF,
      model: "m",
      onProgress: (message) => {
        progress.push(message);
      },
    });
    expect(progress).toEqual(["bad credential «redacted»"]);
    expect(result).toEqual({ ok: false, reason: "meat exited 1: bad credential «redacted»" });
  });
});
