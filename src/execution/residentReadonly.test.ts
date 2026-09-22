import { describe, expect, it } from "vitest";
import { parseEffectOnly, parseReadonly, planReadonlyAttach } from "./residentReadonly.js";

// Feature: docs/reference/specs/resident-repos.md item 50 — a read-only attach gets no
// credential file and an unfetchable origin; a mode switch on a thread
// recreates the tree. Pure decision, imported by the resident Worker.

const MIRROR = "/workspace/mirror";

describe("parseReadonly (the /attach body field)", () => {
  it("absent → false (older bots never send it; the field is additive)", () => {
    expect(parseReadonly(undefined)).toEqual({ readonly: false });
  });
  it("booleans pass through", () => {
    expect(parseReadonly(true)).toEqual({ readonly: true });
    expect(parseReadonly(false)).toEqual({ readonly: false });
  });
  it("anything else is a named error (never coerced — 'true' the string is not true)", () => {
    expect(parseReadonly("true")).toEqual({ error: "readonly must be a boolean when present" });
    expect(parseReadonly(1)).toEqual({ error: "readonly must be a boolean when present" });
    expect(parseReadonly(null)).toEqual({ error: "readonly must be a boolean when present" });
  });
});

describe("parseEffectOnly (the /attach body field)", () => {
  it("is additive, boolean-only and defaults off", () => {
    expect(parseEffectOnly(undefined)).toEqual({ effectOnly: false });
    expect(parseEffectOnly(true)).toEqual({ effectOnly: true });
    expect(parseEffectOnly("true")).toEqual({ error: "effectOnly must be a boolean when present" });
  });
});

describe("planReadonlyAttach", () => {
  it("read-only: no token, scrub credentials, origin = the unreadable mirror", () => {
    expect(planReadonlyAttach({ readonly: true, slug: "acme/api", mirrorDir: MIRROR })).toEqual({
      readonly: true,
      modeSwitch: false,
      credentialScope: "none",
      credentialFile: false,
      scrubCredentials: true,
      originUrl: MIRROR,
    });
  });

  it("writable (the default, and what every pre-existing caller gets): token + GitHub origin, no scrub", () => {
    expect(planReadonlyAttach({ readonly: false, slug: "acme/api", mirrorDir: MIRROR })).toEqual({
      readonly: false,
      modeSwitch: false,
      credentialScope: "write",
      credentialFile: true,
      scrubCredentials: false,
      originUrl: "https://github.com/acme/api.git",
    });
  });

  it("effects-on gives child git a read-scoped credential and switching to or from it recreates the tree", () => {
    expect(planReadonlyAttach({ readonly: false, effectOnly: true, slug: "acme/api", mirrorDir: MIRROR })).toEqual({
      readonly: false,
      modeSwitch: false,
      credentialScope: "read",
      credentialFile: true,
      scrubCredentials: false,
      originUrl: "https://github.com/acme/api.git",
    });
    expect(
      planReadonlyAttach({
        readonly: false,
        effectOnly: true,
        prior: { readonly: false, effectOnly: false },
        slug: "a/b",
        mirrorDir: MIRROR,
      }).modeSwitch,
    ).toBe(true);
    expect(
      planReadonlyAttach({
        readonly: false,
        effectOnly: false,
        prior: { readonly: false, effectOnly: true },
        slug: "a/b",
        mirrorDir: MIRROR,
      }).modeSwitch,
    ).toBe(true);
  });

  it("a live tree built for the OTHER mode is a mode switch → recreate (both directions)", () => {
    expect(
      planReadonlyAttach({ readonly: true, prior: { readonly: false }, slug: "a/b", mirrorDir: MIRROR }).modeSwitch,
    ).toBe(true);
    expect(
      planReadonlyAttach({ readonly: false, prior: { readonly: true }, slug: "a/b", mirrorDir: MIRROR }).modeSwitch,
    ).toBe(true);
  });

  it("a binding predating the field counts as writable: a read-only attach on it switches, a writable one reuses", () => {
    expect(planReadonlyAttach({ readonly: true, prior: {}, slug: "a/b", mirrorDir: MIRROR }).modeSwitch).toBe(true);
    expect(planReadonlyAttach({ readonly: false, prior: {}, slug: "a/b", mirrorDir: MIRROR }).modeSwitch).toBe(false);
  });

  it("same mode → reuse; an evicted prior is gone from disk, so its mode never forces a switch", () => {
    expect(
      planReadonlyAttach({ readonly: true, prior: { readonly: true }, slug: "a/b", mirrorDir: MIRROR }).modeSwitch,
    ).toBe(false);
    expect(
      planReadonlyAttach({ readonly: false, prior: { readonly: true, evicted: true }, slug: "a/b", mirrorDir: MIRROR })
        .modeSwitch,
    ).toBe(false);
  });

  it("a reused read-only tree is still scrubbed — the credential file is written per attach today, so a stale one may exist", () => {
    expect(
      planReadonlyAttach({ readonly: true, prior: { readonly: true }, slug: "a/b", mirrorDir: MIRROR })
        .scrubCredentials,
    ).toBe(true);
  });
});
