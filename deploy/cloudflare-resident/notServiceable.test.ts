import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "./testing/sourceScan";

const require = createRequire(import.meta.url);

/** The pinned SDK's dist, as text: it imports `cloudflare:workers`, so plain Node cannot load it. */
function installedSdkSource(): string {
  const dist = path.dirname(require.resolve("@cloudflare/sandbox"));
  return readdirSync(dist)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(path.join(dist, f), "utf8"))
    .join("\n");
}

/** A regex literal's body, read from a `const NAME = /…/i;` line of a source. */
function regexOf(text: string, name: string): RegExp {
  const literal = new RegExp(`const ${name} =\\s*/(.+)/i;`).exec(text);
  expect(literal, name).not.toBeNull();
  return new RegExp(literal![1], "i");
}

// Feature: docs/reference/specs/execution.md item 9 — the resident client
// types an answer by the fields the resident puts on it, never by its words:
// a 5xx carrying the lifecycle pair (`state`, `stateReason`) waits exactly
// when that pair says the resident is coming back, `reason` stays the answer's
// OWN word (mirror-busy, disk-pressure, image-stale, the not-serviceable
// detail), a resource with no registry record or repo facts says `reason:
// "unregistered"`, and the 500 for a throw no route named — at whichever catch
// met it, the /exec stream's rejection included — says whether the throw was
// the platform's transient (`transient`). These scans hold the Worker to those
// shapes so the client's reading (execInfraReason.test.ts, resident.test.ts)
// stays true. Plain Node, the entry read as text, never loaded.

const source = readSource("worker.ts");

/** Every 503 object literal in the Worker, as text — a `${…}` inside a template literal allowed within it. */
const answers503 = (): string[] => source.match(/\{(?:[^{}]|\$\{[^{}]*\})*status: 503(?:[^{}]|\$\{[^{}]*\})*\}/g) ?? [];

describe("the resident's not-serviceable answers name what the client cannot wait through", () => {
  it('a resource with no registry record or repo facts answers `reason: "unregistered"` at both sites, so the client refuses at once instead of waiting through a restore window that is not coming', () => {
    const sites = source.match(/not-serviceable: registry record or repo facts missing"[^}]*\}/g) ?? [];
    expect(sites).toHaveLength(2);
    for (const site of sites) expect(site).toMatch(/reason: "unregistered"/);
  });

  it("every 503 that carries the lifecycle `state` carries the lifecycle `stateReason` beside it — the hydrate path's not-serviceable answers, mirror-busy, disk-pressure and image-stale alike — and `reason` stays the answer's own word, so the client reads the pair and never mistakes a busy mirror on a degraded-but-serviceable resident for a repo failure", () => {
    const withState = answers503().filter((literal) => /\bstate: /.test(literal));
    expect(withState.length).toBeGreaterThanOrEqual(9);
    for (const literal of withState) {
      expect(literal, literal).toMatch(/\bstateReason: (s\.reason|"")/);
      expect(literal, literal).toMatch(/\breason: ("mirror-busy"|DISK_PRESSURE_REASON|"image-stale"|s\.reason)/);
    }
    expect(withState.filter((l) => /reason: "mirror-busy"/.test(l))).toHaveLength(4);
    expect(withState.filter((l) => /reason: DISK_PRESSURE_REASON/.test(l))).toHaveLength(1);
    expect(withState.filter((l) => /reason: "image-stale"/.test(l))).toHaveLength(1);
    expect(withState.filter((l) => /error: `not-serviceable: \$\{errMsg\(err\)\}`/.test(l))).toHaveLength(3);
  });

  it("every 500 for a throw no route named is one shape that types the throw as a field (`transient`): the fetch handler's catch-all, the streamed /attach and /await-restore rejection mappers, the thread data plane's last resort, and the routes' own catches around their bodies (`attach-failed`; `op-failed` with no step, at the op's catch and the /op stream's rejection) alike — a step that failed stays named and deterministic; the verdict is the typed predicates first (a control reset, a runtime replacement) and then the transient no word names: the runtime unreachable (one cause-chain walk, in `isRuntimeUnreachable`), the pinned SDK's own platform-transient predicate read as the SDK reads it, and the two remainder sentences — never a bare `internal error` or `overloaded`, a git or GitHub word", () => {
    expect(source).toMatch(
      /return \{ error: prefix \? `\$\{prefix\}: \$\{words\}` : words, status: 500, transient \};/,
    );
    expect(source).toMatch(/return unnamedThrowErr\(err, isTransientPlatformThrow\(err\), prefix\);/);
    // The fetch handler and the two streamed control routes' rejection mappers.
    expect(source.match(/catchAllErr\(err\)/g)).toHaveLength(3);
    // Attach's outer catch, its failure builder's unnamed throw, its mutex catch; the op's catch and the /op stream's rejection.
    expect(source.match(/catchAllErr\(err, "attach-failed"\)/g)).toHaveLength(3);
    expect(source.match(/catchAllErr\(err, "op-failed"\)/g)).toHaveLength(2);
    // The thread rejection's last resort hands in its own verdict: no second walk of the typed predicates.
    expect(source.match(/unnamedThrowErr\(err, isUnnamedPlatformTransient\(err\)\)/g)).toHaveLength(1);
    // No bare unnamed-throw 500 is left anywhere.
    expect(source).not.toMatch(/error: `attach-failed: \$\{errMsg\(err\)\}`, status: 500/);
    expect(source).not.toMatch(/op-failed\$\{step\}/);
    expect(source).not.toMatch(/\(err\) => \(\{ error: errMsg\(err\), status: 500 \}\)/);
    expect(source).not.toMatch(/\(err\) => \(\{ error: errMsg\(err\) \}\)/);
    expect(source).not.toMatch(/json\(\{ error: errMsg\(err\) \}, 500\)/);
    // The verdict's shape: typed predicates, then the transient no word names.
    expect(source).toMatch(
      /return isControlReset\(err\) \|\| isRuntimeReplacement\(err\) \|\| isUnnamedPlatformTransient\(err\);/,
    );
    expect(source).toMatch(/if \(isRuntimeUnreachable\(err\) \|\| isPlatformTransientError\(err\)\) return true;/);
    expect(
      source.match(
        /for \(const link of selfAndCauses\(err\)\) if \(isRuntimeUnreachableSignal\(link\)\) return true;/g,
      ),
    ).toHaveLength(1);
    // The SDK's predicate is the pinned package's export, imported beside the reset predicate.
    expect(source).toMatch(/import \{\n {2}isDurableObjectCodeUpdateReset,\n {2}isPlatformTransientError,/);
    const sdk = installedSdkSource();
    expect(sdk).toMatch(/function isPlatformTransientError\(error\) \{/);
    expect(sdk).toMatch(/isPlatformTransientError \}/);
    // What the SDK types transient, read from its source and run: the code-update
    // reset, a lost connection, the storage-startup reset, the typed `retryable`
    // flag; the overloaded sentence is its EXCLUSION (a tight retry adds to a full queue).
    const superseded = regexOf(sdk, "SUPERSEDED_ISOLATE_PATTERN");
    const connectionLost = regexOf(sdk, "CONNECTION_LOST_PATTERN");
    const storageStartup = regexOf(sdk, "DO_STORAGE_STARTUP_RESET_PATTERN");
    expect(sdk).toMatch(/if \(isErrorRetryable\(candidate\)\) return true;/);
    expect(sdk).toMatch(
      /return typed\.retryable === true && typed\.overloaded !== true && !message\.includes\("Durable Object is overloaded"\);/,
    );
    expect(
      storageStartup.test("internal error while starting up durable object storage caused object to be reset"),
    ).toBe(true);
    expect(connectionLost.test("Network connection lost.")).toBe(true);
    expect(superseded.test("reset because its code was updated")).toBe(true);
    for (const pattern of [superseded, connectionLost, storageStartup]) {
      expect(pattern.test("fatal: internal error")).toBe(false);
      expect(pattern.test("Durable Object is overloaded")).toBe(false);
    }
    // Our remainder, read from the source and run: what the SDK's predicate does not name.
    const wording = regexOf(source, "TRANSIENT_PLATFORM_WORDING");
    expect(/const TRANSIENT_PLATFORM_WORDING =\s*\/(.+)\/i;/.exec(source)?.[1]).toBe(
      "storage operation|durable object is overloaded",
    );
    expect(wording.test("Durable Object is overloaded")).toBe(true);
    // The platform's storage-timeout reset (an assumption about its text, named in the source).
    expect(wording.test("Durable Object storage operation exceeded timeout which caused object to be reset.")).toBe(
      true,
    );
    // The SDK's own sentences are the SDK's to name, not the remainder's.
    expect(wording.test("Network connection lost.")).toBe(false);
    expect(wording.test("internal error while starting up durable object storage caused object to be reset")).toBe(
      false,
    );
    // Synthetic negatives: the words a git or GitHub failure carries.
    expect(wording.test("fatal: internal error")).toBe(false);
    expect(wording.test("overloaded")).toBe(false);
    expect(wording.test("GitHub API: overloaded, try again")).toBe(false);
  });

  it("a thread data-plane call that REJECTED — /exec's stream, /read, /write — is answered as the Durable Object answers the same fact inside, by route: the typed predicates first, a control reset the DO's own `control-reset` word on its 409 (never a transient 500 the client would wait on while a write's outcome is unknown); a runtime replacement judged by the DO's own gate as far as it reaches — on /exec the word where the SDK's moved sentence vouches (`sdkVouchesRuntimeMoved`, text that survives the stub boundary) and WITHHELD where only the DO's restore knowledge could (the unknown branch's bare 409 with the SDK's words — the seam's one more command decides), SAID either way on /read and /write (`runtimeReplacedErr`, unconditional there as in the methods, so the client's one re-attach-and-retry fires); and only then the typed 500, its verdict decided once", () => {
    const fn = source.slice(source.indexOf("function threadRejectionErr("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    const reset = body.indexOf('if (isControlReset(err)) return controlResetErr(new ControlResetError("call", err));');
    const replaced = body.indexOf("if (isRuntimeReplacement(err)) {");
    // The DO's gate as far as it reaches: the SDK's vouch by the text that survives the stub boundary; the restore half is the DO's alone.
    const vouched = body.indexOf("const known = sdkVouchesRuntimeMoved(err);");
    const withheld = body.indexOf('if (route === "/exec" && !known) return { error: errMsg(err), status: 409 };');
    const said = body.indexOf('return runtimeReplacedErr(new RuntimeReplacedError("call", err, known));');
    const fallback = body.indexOf("return unnamedThrowErr(err, isUnnamedPlatformTransient(err));");
    expect(reset).toBeGreaterThan(-1);
    expect(replaced).toBeGreaterThan(reset);
    expect(vouched).toBeGreaterThan(replaced);
    expect(withheld).toBeGreaterThan(vouched);
    expect(said).toBeGreaterThan(withheld);
    expect(fallback).toBeGreaterThan(said);
    expect(body).not.toMatch(/knowsContainerGone/);
    // The three thread routes route their rejection through it, each naming itself.
    expect(source.match(/threadRejectionErr\(err, "\/exec"\)/g)).toHaveLength(1);
    expect(source.match(/threadRejectionErr\(err, "\/read"\)/g)).toHaveLength(1);
    expect(source.match(/threadRejectionErr\(err, "\/write"\)/g)).toHaveLength(1);
    expect(source).toMatch(
      /\.readThreadFile\([^)]*\)\s*\.catch\(\(err: unknown\) => threadRejectionErr\(err, "\/read"\)\)/,
    );
    expect(source).toMatch(
      /\.writeThreadFile\([^)]*\)\s*\.catch\(\(err: unknown\) => threadRejectionErr\(err, "\/write"\)\)/,
    );
    // The words it mirrors: the DO's own catch for the same facts — the reset word, the /exec gate's unknown branch, the file methods' unconditional word.
    expect(source).toMatch(/if \(err instanceof ControlResetError\) return controlResetErr\(err\);/);
    expect(source).toMatch(/return \{ error: errMsg\(err\.cause\), status: 409 \};/);
    expect(
      source.match(/if \(err instanceof RuntimeReplacedError\) return runtimeReplacedErr\(err\);/g)?.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("the /exec stream writes every failure through one document builder — a failure the Durable Object named and a pending result that REJECTED (answered as the DO would: the reset word, the replacement's bare 409, the typed 500) alike — so the lifecycle pair, the answer's own word, its status and the catch-all's `transient` ride the stream on both paths, and a rejection is typed by the client like the JSON routes' answer instead of read as a deterministic answer over HTTP 200", () => {
    const stream = source.slice(source.indexOf("function streamThreadExec("));
    const mapping = stream.slice(0, stream.indexOf("\n}\n"));
    expect(mapping).toMatch(/"error" in result\s*\?\s*execFailureDocument\(result\)/);
    expect(mapping).toContain('(err) => execFailureDocument(threadRejectionErr(err, "/exec"))');
    const document = source.slice(source.indexOf("function execFailureDocument("));
    const fields = document.slice(0, document.indexOf("exitCode: 127"));
    for (const forwarded of [
      "state: failure.state",
      "stateReason: failure.stateReason",
      "reason: failure.reason",
      "status: failure.status",
      "transient: failure.transient",
    ])
      expect(fields, forwarded).toContain(forwarded);
    // The rejection mapper of old — the words alone, no status, no transient — is gone.
    expect(source).not.toMatch(/return \{ error: msg, stdout: "", stderr: msg, exitCode: 127 \};/);
  });
});
