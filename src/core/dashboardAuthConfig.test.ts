import { describe, expect, it } from "vitest";
import {
  DASHBOARD_AUTH_MODES,
  DEFAULT_DASHBOARD_TOKEN_ENV,
  resolveDashboardAuthMode,
  tokenSubjectOf,
  validateDashboardConfig,
} from "./dashboardAuthConfig.js";

// Feature: docs/reference/specs/access-gate.md (dashboard auth is a strategy) and
// docs/reference/specs/routing-and-config.md (the `dashboard` block) — the pure half: the
// default-selection rule and the block's validation at load.

describe("resolveDashboardAuthMode — the default-selection rule", () => {
  it("an explicit mode wins over the environment", () => {
    for (const mode of DASHBOARD_AUTH_MODES) {
      expect(resolveDashboardAuthMode(mode, true)).toBe(mode);
      expect(resolveDashboardAuthMode(mode, false)).toBe(mode);
    }
  });

  it("absent → access when ACCESS_* are configured, else none", () => {
    expect(resolveDashboardAuthMode(undefined, true)).toBe("access");
    expect(resolveDashboardAuthMode(undefined, false)).toBe("none");
  });
});

describe("tokenSubjectOf — the actor id a bearer resolves to", () => {
  it("`access:<name>` → name; a service-token id, another namespace, a bare prefix or whitespace is refused", () => {
    expect(tokenSubjectOf("access:ops")).toBe("ops");
    expect(tokenSubjectOf("access:ops-bot.1")).toBe("ops-bot.1");
    expect(tokenSubjectOf("access:svc:ops")).toBeUndefined();
    expect(tokenSubjectOf("http:ops")).toBeUndefined();
    expect(tokenSubjectOf("slack:UALICE")).toBeUndefined();
    expect(tokenSubjectOf("access:")).toBeUndefined();
    expect(tokenSubjectOf("access: ops")).toBeUndefined();
    expect(tokenSubjectOf("ops")).toBeUndefined();
  });
});

describe("validateDashboardConfig — the `dashboard` block is checked at load, naming the key", () => {
  it("accepts an absent block, an empty mapping, each mode, and a token block with or without its env", () => {
    expect(DEFAULT_DASHBOARD_TOKEN_ENV).toBe("DASHBOARD_TOKEN");
    for (const raw of [
      undefined,
      {},
      { auth: "access" },
      { auth: "none" },
      { auth: "token", token: { env: "MY_DASH", actor: "access:ops" } },
      { auth: "token", token: { actor: "access:ops" } },
      { token: { actor: "access:ops" } },
    ]) {
      expect(() => validateDashboardConfig(raw)).not.toThrow();
    }
  });

  it("refuses a non-mapping, an unknown key, an unknown mode (a typo is never `none`), and a bad token block", () => {
    expect(() => validateDashboardConfig("none")).toThrow(/dashboard must be a mapping/);
    expect(() => validateDashboardConfig(["none"])).toThrow(/dashboard must be a mapping/);
    expect(() => validateDashboardConfig({ mode: "none" })).toThrow(/dashboard\.mode is not a known key/);
    expect(() => validateDashboardConfig({ auth: "nnoe" })).toThrow(
      /dashboard\.auth must be one of access, token, none/,
    );
    expect(() => validateDashboardConfig({ auth: true })).toThrow(/dashboard\.auth must be one of/);
    expect(() => validateDashboardConfig({ token: "abc" })).toThrow(/dashboard\.token must be a mapping/);
    expect(() => validateDashboardConfig({ token: { secret: "x" } })).toThrow(
      /dashboard\.token\.secret is not a known key/,
    );
    expect(() => validateDashboardConfig({ token: { env: "" } })).toThrow(
      /dashboard\.token\.env must name an environment variable/,
    );
    expect(() => validateDashboardConfig({ token: { env: 3 } })).toThrow(/dashboard\.token\.env/);
    expect(() => validateDashboardConfig({ token: { actor: "http:ops" } })).toThrow(
      /dashboard\.token\.actor must be an actor id of the form access:<name>/,
    );
    expect(() => validateDashboardConfig({ token: { actor: "access:svc:ops" } })).toThrow(/access:<name>/);
  });

  it("`auth: token` without an actor is refused at load", () => {
    expect(() => validateDashboardConfig({ auth: "token" })).toThrow(
      /dashboard\.auth is token, so dashboard\.token\.actor must name the bearer's actor/,
    );
    expect(() => validateDashboardConfig({ auth: "token", token: { env: "X" } })).toThrow(/dashboard\.token\.actor/);
  });
});
