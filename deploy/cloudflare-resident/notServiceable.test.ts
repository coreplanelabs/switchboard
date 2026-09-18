import { describe, expect, it } from "vitest";
import { readSource } from "./testing/sourceScan";

// Feature: docs/reference/specs/execution.md item 9 — the resident client
// types an answer by the fields the resident puts on it, never by its words:
// a 5xx carrying the lifecycle pair (`state`, `stateReason`) waits exactly
// when that pair says the resident is coming back, `reason` stays the answer's
// OWN word (mirror-busy, disk-pressure, image-stale, the not-serviceable
// detail), a resource with no registry record or repo facts says `reason:
// "unregistered"`, and the 500 for a throw no route named — at whichever catch
// met it, the /exec stream's rejection included — says whether the throw was
// the platform's transient (`transient`). These scans hold the Worker to those
// shapes and to its WIRING of the thread data plane's builders (threadErr.ts,
// whose rules threadErr.test.ts runs with real error shapes), so the client's
// reading (execInfraReason.test.ts, resident.test.ts) stays true. Plain Node,
// the entry read as text, never loaded.

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

  it("every named refusal carries the seam's cause beside its words (record 0054): the onboard 403 is `policy` — the admin's to fix — the thread's ref failures are `request`, and the machinery's own answers are `system`, so a caller reads a field and never the sentence", () => {
    // The onboard 403: the repository is not in the App installation.
    expect(source).toMatch(/not-in-installation[\s\S]{0,900}?cause: "policy"/);
    // needs-ref and unknown-ref, the two ref failures the thread can cause.
    expect(source.match(/cause: "request"/g) ?? []).toHaveLength(3);
    expect(source.match(/cause: "policy"/g) ?? []).toHaveLength(1);
    for (const literal of answers503().filter((l) => /reason: ("mirror-busy"|"unregistered")/.test(l)))
      expect(literal, literal).toMatch(/cause: "system"/);
  });

  it("the Worker wires the thread data plane's builders from threadErr.ts over the predicates only it can supply — the SDK's reset and platform-transient predicates, imported side by side, and its own replacement classifier and vouch — and defines none of the shapes or rules itself, so what threadErr.test.ts runs is what the Worker answers", () => {
    expect(source).toMatch(/import \{\n {2}isDurableObjectCodeUpdateReset,\n {2}isPlatformTransientError,/);
    expect(source).toMatch(
      /import \{\n(?: {2}\w+,\n)*? {2}threadErrBuilders,\n(?: {2}(?:type )?\w+,\n)* {0}\} from "\.\/threadErr";/,
    );
    expect(source).toMatch(
      /const \{ catchAllErr, threadRejectionErr \} = threadErrBuilders\(\{\s*isControlReset,\s*isRuntimeReplacement,\s*sdkVouchesRuntimeMoved,\s*isPlatformTransientError,\s*\}\);/,
    );
    expect(source).not.toMatch(
      /^(?:async )?function (?:catchAllErr|threadRejectionErr|execFailureDocument|runtimeReplacedErr|controlResetErr|unnamedThrowErr|isTransientPlatformThrow)\(/m,
    );
    expect(source).not.toMatch(/^class (?:RuntimeReplacedError|ControlResetError) /m);
    expect(source).not.toMatch(/TRANSIENT_PLATFORM_WORDING|^interface ThreadErr /m);
    // The predicates handed in are the Worker's own, still here: the SDK's reset
    // predicate behind `isControlReset`, the classifier and the vouch over the
    // SDK's typed classes, and the run() path's unreachable walk — once.
    expect(source).toMatch(
      /^function isControlReset\(err: unknown\): boolean \{\n {2}return isDurableObjectCodeUpdateReset\(err\);/m,
    );
    expect(source).toMatch(/^function isRuntimeReplacement\(err: unknown\): boolean \{/m);
    expect(source).toMatch(/^function sdkVouchesRuntimeMoved\(err: unknown\): boolean \{/m);
    expect(
      source.match(
        /for \(const link of selfAndCauses\(err\)\) if \(isRuntimeUnreachableSignal\(link\)\) return true;/g,
      ),
    ).toHaveLength(1);
  });

  it("every 500 for a throw no route named goes through `catchAllErr`: the fetch handler's catch-all, the streamed /attach and /await-restore rejection mappers, and the routes' own catches around their bodies (`attach-failed`; `op-failed` with no step, at the op's catch and the /op stream's rejection) — a step that failed stays named and deterministic, and no bare unnamed-throw 500 is left anywhere", () => {
    // The fetch handler and the two streamed control routes' rejection mappers.
    expect(source.match(/catchAllErr\(err\)/g)).toHaveLength(3);
    // Attach's outer catch, its failure builder's unnamed throw, its mutex catch; the op's catch and the /op stream's rejection.
    expect(source.match(/catchAllErr\(err, "attach-failed"\)/g)).toHaveLength(3);
    expect(source.match(/catchAllErr\(err, "op-failed"\)/g)).toHaveLength(2);
    expect(source).toMatch(
      /if \(err instanceof StepError\) return \{ error: `op-failed at \$\{err\.step\}: \$\{errMsg\(err\)\}`, status: 500 \};/,
    );
    expect(source).not.toMatch(/error: `attach-failed: \$\{errMsg\(err\)\}`, status: 500/);
    expect(source).not.toMatch(/op-failed\$\{step\}/);
    expect(source).not.toMatch(/\(err\) => \(\{ error: errMsg\(err\), status: 500 \}\)/);
    expect(source).not.toMatch(/\(err\) => \(\{ error: errMsg\(err\) \}\)/);
    expect(source).not.toMatch(/json\(\{ error: errMsg\(err\) \}, 500\)/);
    expect(source).not.toMatch(/return \{ error: msg, stdout: "", stderr: msg, exitCode: 127 \};/);
  });

  it("the thread data plane's three routes route a rejected stub call through `threadRejectionErr`, each naming itself, and the DO's own catches keep answering the same facts by the same words inside — so a rejection and an in-method failure are one answer", () => {
    expect(source.match(/threadRejectionErr\(err, "\/exec"\)/g)).toHaveLength(1);
    expect(source.match(/threadRejectionErr\(err, "\/read"\)/g)).toHaveLength(1);
    expect(source.match(/threadRejectionErr\(err, "\/write"\)/g)).toHaveLength(1);
    expect(source).toMatch(
      /\.readThreadFile\([^)]*\)\s*\.catch\(\(err: unknown\) => threadRejectionErr\(err, "\/read"\)\)/,
    );
    expect(source).toMatch(
      /\.writeThreadFile\([^)]*\)\s*\.catch\(\(err: unknown\) => threadRejectionErr\(err, "\/write"\)\)/,
    );
    // The words the builders mirror: the DO's own catch for the same facts —
    // the reset word, the /exec gate's unknown branch, the file methods' unconditional word.
    expect(source).toMatch(/if \(err instanceof ControlResetError\) return controlResetErr\(err\);/);
    expect(source).toMatch(/return \{ error: errMsg\(err\.cause\), status: 409 \};/);
    expect(
      source.match(/if \(err instanceof RuntimeReplacedError\) return runtimeReplacedErr\(err\);/g)?.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("the /exec stream writes every failure through `execFailureDocument` — a failure the Durable Object named and a pending result that rejected alike — so the lifecycle pair, the answer's own word, its status and the catch-all's `transient` ride the stream on both paths", () => {
    const stream = source.slice(source.indexOf("function streamThreadExec("));
    const mapping = stream.slice(0, stream.indexOf("\n}\n"));
    expect(mapping).toMatch(/"error" in result\s*\?\s*execFailureDocument\(result\)/);
    expect(mapping).toContain('(err) => execFailureDocument(threadRejectionErr(err, "/exec"))');
  });
});
