import { describe, expect, it } from "vitest";
import { readSource } from "./testing/sourceScan";

// Feature: docs/reference/specs/execution.md item 9 — the resident client
// types a 5xx answer as the resident unavailable (a wait may clear it: a
// restore under way, the mirror mutex held by a refresh) unless the body names
// a refusal no wait clears. The two such refusals are typed ON the answer, so
// the client reads a field and never the words: a resident `down` rides as
// `state` on every not-serviceable answer the hydrate path writes, and a
// resource with no registry record or repo facts says `reason:
// "unregistered"`. Plain Node, the entry read as text, never loaded.

const source = readSource("worker.ts");

describe("the resident's not-serviceable answers name what the client cannot wait through", () => {
  it('a resource with no registry record or repo facts answers `reason: "unregistered"` at both sites, so the client refuses at once instead of waiting through a restore window that is not coming', () => {
    const sites = source.match(/not-serviceable: registry record or repo facts missing"[^}]*\}/g) ?? [];
    expect(sites).toHaveLength(2);
    for (const site of sites) expect(site).toMatch(/reason: "unregistered"/);
  });

  it("every not-serviceable answer the hydrate path writes carries the resident's `state`, so a `down` resident is read as the state and never as words", () => {
    const sites = source.match(/error: `not-serviceable: \$\{errMsg\(err\)\}`[^}]*\}/g) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(3);
    for (const site of sites) expect(site).toMatch(/state: s\.state/);
  });
});
