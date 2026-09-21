import { describe, expect, it } from "vitest";
import { turnEffort } from "./turnEffort.js";
import type { CardRegistry } from "../modelCard.js";
import type { ProviderConfig } from "../provider.js";

// Feature: docs/reference/specs/routing-and-config.md item 2 — the effort of a
// model turn that is not a preset run (the operator's, the router's, intake's,
// reflection's) is decided by the same card path a preset's effort takes:
// vouched or degraded by the levels map, dropped with a note when refused,
// absent when no key is set.

/** No registry card for anything: the operator's `models.<id>.levels` (or the
 *  wire's unknown default) is the whole card, as `catalog: "none"` blocks are. */
const NO_REGISTRY: CardRegistry = { card: () => undefined };

const blocks: Record<string, ProviderConfig> = {
  acme: {
    type: "openai-compatible",
    wire: "openai-chat",
    baseUrl: "https://acme.example",
    catalog: "none",
    models: { m: { levels: { low: "quick", high: "deep", max: null } } },
  },
  bare: { type: "openai-compatible", wire: "openai-chat", baseUrl: "https://bare.example", catalog: "none" },
};

describe("turnEffort — a non-preset turn's effort through the model card", () => {
  it("no configured tier is no decision at all: no request, no note", () => {
    expect(turnEffort("acme/m", undefined, blocks, NO_REGISTRY)).toEqual({});
  });

  it("a tier the levels map names goes out vouched, with the map's wire word and no note", () => {
    expect(turnEffort("acme/m", "low", blocks, NO_REGISTRY)).toEqual({
      request: { effort: "low", effortWord: "quick" },
    });
  });

  it("an unnamed xhigh degrades to the highest named tier below it — the fallback word rides with the why", () => {
    const out = turnEffort("acme/m", "xhigh", blocks, NO_REGISTRY);
    expect(out.request).toEqual({ effort: "xhigh", effortWord: "deep" });
    expect(out.note).toContain('does not take effort "xhigh"');
  });

  it("a tier the map refuses (null) drops the effort with a note — the turn still runs, at the model's default", () => {
    const out = turnEffort("acme/m", "max", blocks, NO_REGISTRY);
    expect(out.request).toBeUndefined();
    expect(out.note).toContain('does not take effort "max"');
  });

  it("unknown levels (no layer names them) send the tier's own word unvouched, the note saying so", () => {
    const out = turnEffort("bare/m", "high", blocks, NO_REGISTRY);
    expect(out.request).toEqual({ effort: "high", effortWord: "high" });
    expect(out.note).toContain("no layer names m's levels");
  });

  it("a block the config does not declare still answers — unknown levels, never a throw: the background turn must run", () => {
    const out = turnEffort("ghost/m", "medium", blocks, NO_REGISTRY);
    expect(out.request).toEqual({ effort: "medium", effortWord: "medium" });
  });
});
