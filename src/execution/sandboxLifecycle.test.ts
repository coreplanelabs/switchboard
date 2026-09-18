import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DETACH_HINT,
  DETACH_REDIRECTS,
  OUTPUT_AFTER_EXIT_MS,
  SANDBOX_SLEEP_AFTER,
  heldOutputNote,
  isRecycleError,
  recycledMidCommandMessage,
} from "./sandboxLifecycle.js";
import { EXEC_CALL_MARGIN_MS } from "./bashTimeout.js";
import { DETACHED_STDIO } from "../core/harness/container.js";

// Feature: docs/reference/specs/execution.md items 1, 2 and 9 — the per-thread
// sandbox's idle lifetime, and the naming of a container whose runtime was
// replaced or restarted under a command.

const ROOT = resolve(import.meta.dirname, "../..");

describe("the idle lifetime", () => {
  it("is five minutes, in the Container class's own grammar", () => {
    expect(SANDBOX_SLEEP_AFTER).toBe("5m");
  });
});

describe("recycledMidCommandMessage", () => {
  const RECYCLED =
    /^sandbox recycled mid-command after \d+s — the container's runtime was replaced or restarted under the command, which did not finish/;

  it("leaves an early failure with any message alone", () => {
    expect(recycledMidCommandMessage(5_000, "Session 'abc' not found")).toBe("Session 'abc' not found");
    expect(recycledMidCommandMessage(5_000, "Command execution failed")).toBe("Command execution failed");
  });

  it("leaves a recycle-shaped failure alone inside the first minute — that is a real startup failure, not a recycle", () => {
    expect(recycledMidCommandMessage(60_000, "Command execution failed")).toBe("Command execution failed");
    expect(recycledMidCommandMessage(60_000, "Session terminated")).toBe("Session terminated");
  });

  it("names the recycle when a recycle-shaped failure arrives after more than a minute, and tells the model to look at /workspace before assuming either outcome", () => {
    const generic = recycledMidCommandMessage(61_000, "Command execution failed");
    expect(generic).toMatch(RECYCLED);
    expect(generic).toContain("after 61s");
    expect(generic).toContain("check /workspace before continuing");
    expect(generic).toContain("empty if the container was replaced (re-clone)");
    expect(generic).toContain("intact if only its runtime restarted");
    expect(generic).toContain("(Command execution failed)");
    expect(recycledMidCommandMessage(1_200_000, "Session terminated")).toMatch(RECYCLED);
    expect(recycledMidCommandMessage(90_000, "Session 'sandbox-slack:C1:1.0' not found")).toMatch(RECYCLED);
  });

  it("never rewords an unrelated failure on timing alone — a late transport error keeps its own text", () => {
    expect(recycledMidCommandMessage(1_200_000, "fetch failed")).toBe("fetch failed");
    expect(recycledMidCommandMessage(1_200_000, "Failed to create session: 503")).toBe("Failed to create session: 503");
  });

  it("recognizes the 0.12.x recycle texts — a terminated session shell and a container stopped under a pending call", () => {
    expect(recycledMidCommandMessage(90_000, "Session 'sandbox-slack:C1:1.0' shell exited (exit code: 143)")).toMatch(
      RECYCLED,
    );
    expect(recycledMidCommandMessage(90_000, "The sandbox container stopped while the operation was pending.")).toMatch(
      RECYCLED,
    );
  });

  // A sandbox `destroy()`ed under a pending call disconnects it with this
  // text — the container really is gone.
  it("recognizes the destroy-time disconnect text as a recycle", () => {
    expect(recycledMidCommandMessage(90_000, "The sandbox was destroyed while the operation was pending.")).toMatch(
      RECYCLED,
    );
    expect(recycledMidCommandMessage(5_000, "The sandbox was destroyed while the operation was pending.")).toBe(
      "The sandbox was destroyed while the operation was pending.",
    );
  });

  it("a typed recycle error (certain) is named at any elapsed time — the SDK is stating the runtime went away", () => {
    const msg = recycledMidCommandMessage(3_000, "Session 'x' shell exited (exit code: 143)", true);
    expect(msg).toMatch(RECYCLED);
    expect(msg).toContain("after 3s");
    // `certain` is the caller's typed evidence, so it rewords whatever text the
    // typed error carried; without it the shape-plus-time gate still holds
    expect(recycledMidCommandMessage(3_000, "fetch failed", false)).toBe("fetch failed");
    expect(recycledMidCommandMessage(3_000, "fetch failed", true)).toMatch(RECYCLED);
  });
});

describe("isRecycleError", () => {
  it("takes the SDK's typed errors by NAME across the 0.12 and 0.13 lines (the RPC boundary drops the prototype)", () => {
    expect(isRecycleError({ name: "SessionTerminatedError", message: "whatever the text" })).toBe(true);
    expect(isRecycleError({ name: "OperationInterruptedError", message: "…" })).toBe(true);
    expect(isRecycleError({ name: "StaleProcessHandleError", message: "…" })).toBe(true);
    expect(isRecycleError({ name: "RuntimeIdentityInactiveError", message: "…" })).toBe(true);
  });

  it("falls back to the recycle-shaped texts, and rejects everything else", () => {
    expect(isRecycleError({ name: "Error", message: "Command execution failed" })).toBe(true);
    expect(
      isRecycleError({ name: "Error", message: "The sandbox container stopped while the operation was pending." }),
    ).toBe(true);
    expect(
      isRecycleError({ name: "Error", message: "The sandbox was destroyed while the operation was pending." }),
    ).toBe(true);
    expect(isRecycleError({ name: "ContainerUnavailableError", message: "no Container instance available" })).toBe(
      false,
    );
    expect(isRecycleError({ name: "Error", message: "fetch failed" })).toBe(false);
    expect(isRecycleError({})).toBe(false);
  });
});

// Feature: docs/reference/specs/execution.md item 24 — a command's output ends
// when the command does. A detached child that inherited the exec's stdout and
// stderr held the runtime's output stream open past the executor's deadline;
// the seam redirects its wrapper's stdio, the hint tells the model to do the
// same, and the Worker answers an exited process whose output never ended.
describe("held output pipes", () => {
  it("the detach redirects are one string, shared by the harness seam's start and the exit-124 hint", () => {
    expect(DETACH_REDIRECTS).toBe("</dev/null >/dev/null 2>&1");
    expect(DETACHED_STDIO).toBe(DETACH_REDIRECTS);
    expect(DETACH_HINT).toBe("setsid -f sh -c '<command> > /tmp/job.log 2>&1' </dev/null >/dev/null 2>&1");
  });

  it("the Worker's wait for the output to end past the command's deadline stays inside the executor's per-send margin", () => {
    expect(OUTPUT_AFTER_EXIT_MS).toBe(20_000);
    expect(OUTPUT_AFTER_EXIT_MS).toBeLessThan(EXEC_CALL_MARGIN_MS);
  });

  it("the held-output note names the exit code, says the output is lost to this call and the job runs on, and spells the detach", () => {
    const note = heldOutputNote(0);
    expect(note).toContain("the command exited (code 0)");
    expect(note).toContain("still holds its stdout or stderr open");
    expect(note).toContain("its output is lost to this call, the job itself is still running");
    expect(note).toContain(`detach with \`${DETACH_HINT}\``);
    expect(heldOutputNote(3)).toContain("(code 3)");
  });
});

describe("sandbox Worker wiring (static)", () => {
  // The Worker cannot run under vitest (Durable Objects + a container), so
  // this mirrors scripts/check-sandbox-pair.mjs: read the source and require
  // the seams to be wired. Drop one and the suite goes red, not a review some
  // months later.
  const worker = readFileSync(resolve(ROOT, "deploy/cloudflare-sandbox/worker.ts"), "utf8");

  it("the Durable Object's sleepAfter is the shared constant, and a command is one supervised process started and collected inside the Durable Object", () => {
    expect(worker).toMatch(/sleepAfter\s*=\s*SANDBOX_SLEEP_AFTER/);
    expect(worker).toContain("createExtensionProcessSandbox(this).exec(");
    expect(worker).toMatch(/proc\.output\(\{ encoding: "utf8"/);
    // No session, no session fence, no keepalive: the 0.13 line has none of them.
    expect(worker).not.toContain("resetDefaultSession");
    expect(worker).not.toContain("withActivityKeepalive");
    expect(worker).not.toContain("renewActivityTimeout");
  });

  // docs/reference/specs/execution.md item 2: every /exec runs under `timeout …
  // bash -c`, whose process group is reaped when the command returns, so a
  // `nohup … &` job dies with the command that started it while a `setsid -f`
  // job outlives it. The hint the model reads on an exit 124 must name the
  // tool that works and never the one that does not.
  it("the timeout hint tells the model to detach a long job with setsid -f and the wrapper's stdio redirected, and never names nohup", () => {
    expect(worker).toMatch(/start it detached with \\`\$\{DETACH_HINT\}\\`/);
    expect(worker).not.toContain("nohup");
  });

  // item 24: the output wait past the command's deadline is the shared
  // constant, and a wait that runs out asks the runtime — an exited process
  // is answered with its code and the held-output note, a running one is
  // killed and answered as the shell-level timeout.
  it("an output that never ends is told apart by the process's status: exited → its code and the held-output note, running → kill and exit 124", () => {
    expect(worker).toMatch(
      /proc\.output\(\{\s*encoding: "utf8",\s*timeout: execTimeoutSecs \* 1000 \+ OUTPUT_WAIT_AFTER_DEADLINE_MS,?\s*\}\)/,
    );
    expect(worker).toMatch(/const OUTPUT_WAIT_AFTER_DEADLINE_MS = OUTPUT_AFTER_EXIT_MS;/);
    expect(worker).toMatch(
      /const status = await proc\.status\(\)\.catch\(\(\) => null\);\s*if \(status\?\.state === "exited"\) \{\s*return \{\s*stdout: "",\s*stderr: heldOutputNote\(status\.exit\.code\),\s*exitCode: status\.exit\.code,/,
    );
    expect(worker).toMatch(/await proc\.kill\(9\)\.catch\(\(\) => \{\}\);/);
  });

  it("the /exec failure path names a mid-command recycle by type inside the Durable Object and by name after the RPC boundary, a full fleet, and a silent control port", () => {
    expect(worker).toContain("recycledMidCommandMessage(");
    expect(worker).toContain("isRecycleError(");
    expect(worker).toContain("isFleetBusyError(");
    expect(worker).toContain("isRuntimeUnreachableSignal(");
    expect(worker).toContain("instanceof StaleProcessHandleError");
    expect(worker).toContain("instanceof OperationInterruptedError");
  });

  // item 28: the platform's accept refusal is the wait token only where no
  // process was started — the spawn and the gate's warm-up — never on the
  // output of a running command, whose re-send would run it twice; the file
  // routes throw the typed error and the fetch handler answers 503 with the
  // token; a busy error that escaped the Durable Object is still named.
  it("a refused connect is the runtime-busy token at the spawn and the warm-up alone, the file routes' 503, and named after the RPC boundary", () => {
    // The spawn's catch and the warm-up's catch go through `spawnFailure`; the output's catch does not.
    expect(worker).toMatch(
      /proc = await createExtensionProcessSandbox\(this\)\.exec\(argv, \{ env: envVars, timeout: backstopMs \}\);\s*\} catch \(err\) \{[^}]*return this\.spawnFailure\(err, startedAt\);/,
    );
    expect(worker).toMatch(
      /\(cause\) => sandboxStartingExecAnswer\(cause\),\s*\);\s*\} catch \(err\) \{[^}]*return this\.spawnFailure\(err, startedAt\);/,
    );
    expect(worker).toMatch(
      /await proc\.kill\(9\)\.catch\(\(\) => \{\}\);[\s\S]*?\}\s*return this\.execFailure\(err, startedAt\);/,
    );
    expect(worker.match(/this\.spawnFailure\(/g)).toHaveLength(2);
    // spawnFailure names the token through the platform's wording; execFailure never does.
    expect(worker).toMatch(/private spawnFailure\([\s\S]*?isRuntimeBusy\(err\)[\s\S]*?runtimeBusyExecAnswer\(/);
    const execFailureBody = worker.slice(
      worker.indexOf("private execFailure("),
      worker.indexOf("private runtimeUnreachable("),
    );
    expect(execFailureBody).not.toContain("isRuntimeBusy(");
    expect(worker).toContain("isRuntimeBusySignal(link)");
    // The file routes and the fetch handler.
    expect(worker).toMatch(/isRuntimeBusy\(err\)\) throw this\.runtimeBusy\(thrownText\(shape\)\);/);
    expect(worker).toMatch(/if \(isRuntimeBusyError\(err\)\) return json\(runtimeBusyAnswer\(msg\), 503\);/);
    expect(worker).toMatch(/if \(isRuntimeBusyError\(err\)\) return runtimeBusyExecAnswer\(raw\);/);
  });

  // The credential rides in the SDK's per-process `env` option, so it never
  // appears in the command text the SDK logs. The 0.3.x base64 export prefix
  // put the live GH_TOKEN into every "Command executed" log line.
  it("the credential goes through the exec env option, never through the command text", () => {
    expect(worker).toMatch(/env:\s*envVars/);
    expect(worker).not.toContain("base64 -d");
    expect(worker).not.toContain("btoa(");
  });

  // Workers Logs record an invocation's request headers (redacted by a name
  // heuristic only, so a header not named like a token is logged in clear),
  // not its body. The Worker reads the env map from the body alone through ONE
  // helper, and the executor sends it in the body alone — neither source names
  // the header channel.
  it("the Worker reads the env map through envFromRequest and names no x-env header channel", () => {
    expect(worker).toMatch(/const envVars\s*=\s*envFromRequest\(/);
    expect(worker).not.toMatch(/x-env-/i);
  });

  it("the executor sends the env in the body alone — no x-env-* header", () => {
    const executor = readFileSync(resolve(ROOT, "src/execution/cloudflareSandbox.ts"), "utf8");
    expect(executor).toMatch(/const envs\s*=\s*await this\.opts\.resolveEnvs\(\)/);
    // The resolved credential is the body's env — a caller's own variables
    // (harness-pi item 4) join it there, under the credential.
    expect(executor).toMatch(/env:\s*\{ \.\.\.callerEnv, \.\.\.envs \}/);
    expect(executor).not.toMatch(/x-env-/i);
  });

  // docs/reference/specs/execution.md items 3 and 6: a failure text is never
  // empty. Both Worker catches go through `thrownText`; the bare
  // `shape.message ?? String(err)` that kept the SDK's "" is gone.
  it("every failure text goes through thrownText — the empty-string fallthrough is gone", () => {
    expect(worker).toContain("thrownText(");
    expect(worker).not.toContain(".message ?? String(err)");
  });

  // items 9 and 14: the executor waits on `reason`, never on the text, so a
  // refusal the Durable Object named — the stat under a binary read on a full
  // fleet included — leaves with its token.
  it("a file route's refusal carries the Durable Object's reason token", () => {
    expect(worker).toContain("function refused(r: FileRefusal)");
    expect(worker).toMatch(/reason: r\.reason/);
    expect(worker).toMatch(/status: 503, reason: stat\.reason/);
  });

  // item 22: the one place the Worker ends a container is the idle guard's
  // host — the SDK's clean destroy and the platform's kill are handed to
  // IdleGuard, which decides from served-time alone; no route destroys, and
  // the SDK's own expiry hook is answered by the guard, never left to its
  // process probes.
  it("the Worker destroys a container only through the idle guard, and answers the SDK's expiry with the guard's verdict", () => {
    expect(worker.match(/this\.destroy\(/g)).toHaveLength(1);
    expect(worker).toMatch(/destroySandbox: \(\) => this\.destroy\(\)/);
    expect(worker.match(/container\?\.destroy\(\)/g)).toHaveLength(1);
    expect(worker).toMatch(/override async onActivityExpired\(\): Promise<void> \{\s*await this\.idle\.expired\(\);/);
    expect(worker).toMatch(/blockConcurrencyWhile\(\(\) => this\.idle\.wake\(\)\)/);
    // every route the fetch handler calls runs inside served() — the seed among them (item 25) — and so does the start gate's warm-up
    expect(worker.match(/this\.idle\.served\(/g)).toHaveLength(6);
  });

  // item 23: every route passes through the start gate, whose warm-up is one
  // trivial command through the SDK inside the idle ledger; a route answers
  // the token (exec shape in-body, 503 on the file routes) while it starts.
  it("the instance grant is asked for with a ten-second limit, so a refused start under a burst reaches the gate in seconds", () => {
    expect(worker).toMatch(/const INSTANCE_GET_TIMEOUT_MS = 10_000;/);
    expect(worker).toMatch(
      /getSandbox\(env\.Sandbox, threadKey, \{\s*containerTimeouts: \{[\s\S]*?instanceGetTimeoutMS: INSTANCE_GET_TIMEOUT_MS,\s*\},\s*\}\)/,
    );
  });

  it("every route goes through the start gate; the warm-up is `true` through the SDK inside the idle ledger", () => {
    expect(worker.match(/this\.gate\.through\(/g)).toHaveLength(5);
    expect(worker).toMatch(
      /warmUp: \(\) =>\s*this\.idle\.served\(async \(\) => \{\s*const proc = await createExtensionProcessSandbox\(this\)\.exec\(\["true"\]/,
    );
    expect(worker).toMatch(/\(cause\) => sandboxStartingExecAnswer\(cause\)/);
    expect(worker.match(/\(cause\) => this\.startingRefusal\(cause\)/g)).toHaveLength(3);
    expect(worker).toMatch(/return \{ error, status: 503, reason \};/);
  });

  // The rollout window a NEW thread can fall into is closed by replacing the
  // old-image instances in ONE wave: rollout_step_percentage 100, not the
  // platform's default [10, 100] that left minutes between the waves.
  it("wrangler.jsonc rolls the sandbox image out in one wave (rollout_step_percentage 100)", () => {
    const wrangler = readFileSync(resolve(ROOT, "deploy/cloudflare-sandbox/wrangler.jsonc"), "utf8");
    const m = /"rollout_step_percentage":\s*(\d+)/.exec(wrangler);
    expect(m?.[1]).toBe("100");
  });
});
