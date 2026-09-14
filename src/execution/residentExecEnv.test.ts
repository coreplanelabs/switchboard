import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

// Feature: docs/reference/specs/harness-pi.md item 4 — the resident Worker
// carries a caller's extra environment for one `/exec` the way the sandbox
// Worker does: read from the body alone through the one validated reader,
// handed to the SDK's per-exec env option, never onto the command text. The
// Worker cannot run under vitest (a Durable Object over a container), so this
// mirrors the sandbox Worker's static guard: read the source and require the
// seam to be wired, so dropping it goes red here, not in a run.
describe("resident Worker /exec env (static)", () => {
  const worker = readFileSync(resolve(ROOT, "deploy/cloudflare-resident/worker.ts"), "utf8");

  it("reads the env map from the body through envFromRequest and hands it to execThread", () => {
    expect(worker).toMatch(/import \{ envFromRequest \} from "\.\.\/\.\.\/src\/execution\/sandboxEnv\.js";/);
    expect(worker).toMatch(/const execEnv = envFromRequest\(\{ body \}\);/);
    expect(worker).toMatch(/execThread\(ctx\.threadKey, body\.command, timeoutMs, traceparent, execEnv\)/);
  });

  it("threads the env through to the thread run, merged under the Worker's own injected variables and validated by name", () => {
    expect(worker).toMatch(/const injected = \{ \.\.\.\(env \?\? \{\}\), GIT_TERMINAL_PROMPT: "0" \};/);
    expect(worker).toMatch(/validateEnvNames\(injected\)/);
  });

  it("reads the env from no request header — the header channel appears only in the note that says it is ignored", () => {
    expect(worker).not.toMatch(/headers\.get\(\s*["'`]x-env/i);
    expect(worker).not.toMatch(/request\.headers[^\n]*x-env/i);
  });
});
