import { describe, expect, it } from "vitest";
import { readSource } from "./testing/sourceScan";

// Feature: docs/reference/specs/execution.md item 9 — the resident client
// types an answer by the fields the resident puts on it, never by its words:
// a 5xx carrying the lifecycle pair (`state`, `stateReason`) waits exactly
// when that pair says the resident is coming back, `reason` stays the answer's
// OWN word (mirror-busy, disk-pressure, image-stale, the not-serviceable
// detail), a resource with no registry record or repo facts says `reason:
// "unregistered"`, and the fetch handler's catch-all 500 says whether the throw
// it wrapped was the platform's transient (`transient`). These scans hold the
// Worker to those shapes so the client's reading (execInfraReason.test.ts
// mirrors them) stays true. Plain Node, the entry read as text, never loaded.

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

  it("the fetch handler's catch-all 500 is one builder that types the throw: `transient` from the platform's own signals (a control reset, a runtime replacement, the runtime unreachable, the platform's transient wording), at every catch-all site", () => {
    expect(source.match(/catchAllErr\(err\)/g)).toHaveLength(3);
    expect(source).toMatch(
      /return \{ error: errMsg\(err\), status: 500, transient: isTransientPlatformThrow\(err\) \};/,
    );
    expect(source).toMatch(/if \(isControlReset\(err\) \|\| isRuntimeReplacement\(err\)\) return true;/);
    expect(source).toMatch(/if \(isRuntimeUnreachableSignal\(link\)\) return true;/);
    // No bare catch-all is left: every unnamed throw goes through the builder.
    expect(source).not.toMatch(/\(err\) => \(\{ error: errMsg\(err\), status: 500 \}\)/);
    expect(source).not.toMatch(/json\(\{ error: errMsg\(err\) \}, 500\)/);
  });
});
