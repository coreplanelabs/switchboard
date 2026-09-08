// Feature: features/resident-repos.md item 62 — resident-supplied text is made
// safe at the seams: the resident sanitizes at the write and the exit, the bot
// at the parse, so no card, reply, listing or record shows raw remote output.
import { describe, expect, it } from "vitest";
import { RESIDENT_TEXT_CAP, residentState, residentText, sanitizeResidentBody } from "./residentText.js";

// A reason the way a hostile or merely unlucky resident could build it: a
// token, an ANSI-laced second line, another thread's key.
const POISON =
  "provision-failed at install: \x1b[31mnpm ERR!\x1b[0m GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n" +
  "kept slack:C0OTHER:1234.5678 (busy)";

describe("residentText", () => {
  it("strips ANSI, redacts the credential and caps at RESIDENT_TEXT_CAP", () => {
    const out = residentText(POISON);
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).toContain("«redacted");
    expect(residentText("x".repeat(RESIDENT_TEXT_CAP + 50))).toHaveLength(RESIDENT_TEXT_CAP + 1); // + the ellipsis
  });

  it("is the identity on the discriminators the bot compares", () => {
    expect(residentText("runtime-replaced")).toBe("runtime-replaced");
    const refused =
      'op-refused: the "test" command-table entry is marked effects: write — the modelless op path executes readonly entries only';
    expect(residentText(refused)).toBe(refused);
    expect(residentText("disk-pressure: need 0.93 GiB")).toBe("disk-pressure: need 0.93 GiB");
  });
});

describe("sanitizeResidentBody", () => {
  it("rewrites error, reason and summary, mirrors stderr only when it copied error, leaves the rest alone", () => {
    const body = {
      error: POISON,
      reason: POISON,
      summary: POISON,
      stderr: POISON,
      stdout: POISON,
      needs: "attach",
      state: "down",
      status: 503,
      exitCode: 127,
    };
    const out = sanitizeResidentBody(body);
    for (const k of ["error", "reason", "summary", "stderr"] as const) {
      expect(out[k]).not.toContain("ghp_");
      expect(out[k]).not.toContain("\x1b");
    }
    expect(out.stderr).toBe(out.error);
    expect(out.stdout).toBe(POISON); // tool output has its own redaction at publish
    expect(out.needs).toBe("attach");
    expect(out.state).toBe("down");
    expect(out.status).toBe(503);
    expect(out.exitCode).toBe(127);
    expect(body.error).toBe(POISON); // pure: the input is untouched
  });

  it("leaves a stderr that is not a mirror of error untouched, and passes scalars through", () => {
    const out = sanitizeResidentBody({ error: "boom", stderr: "real stderr text" });
    expect(out.stderr).toBe("real stderr text");
    expect(sanitizeResidentBody(null)).toBeNull();
    expect(sanitizeResidentBody("text")).toBe("text");
    expect(sanitizeResidentBody(7)).toBe(7);
  });

  it("descends into arrays and nested objects — the `/residents` listing nests each reason under residents[].live", () => {
    const body = {
      cap: 8,
      residents: [
        { resource: "repo:acme/api", live: { state: "degraded", reason: POISON } },
        { resource: "repo:acme/web", live: { error: POISON } },
      ],
    };
    const out = sanitizeResidentBody(body);
    expect(out.residents[0].live.reason).not.toContain("ghp_");
    expect(out.residents[0].live.reason).not.toContain("\x1b");
    expect(out.residents[0].live.state).toBe("degraded");
    expect(out.residents[1].live.error).not.toContain("ghp_");
    expect(out.residents[0].resource).toBe("repo:acme/api");
    expect(out.cap).toBe(8);
    expect(body.residents[0].live.reason).toBe(POISON); // pure
    // The walk is bounded: text below the depth bound is left alone rather than
    // walked forever, and nothing throws.
    const deep = { a: { b: { c: { d: { e: { reason: POISON } } } } } };
    expect(() => sanitizeResidentBody(deep)).not.toThrow();
  });
});

describe("residentState", () => {
  it("admits the lifecycle union and the two local literals; anything else is unknown", () => {
    for (const s of ["onboarding", "warm", "refreshing", "restoring", "degraded", "down", "not-onboarded", "unknown"]) {
      expect(residentState(s)).toBe(s);
    }
    expect(residentState("warm\nGITHUB_TOKEN=ghp_x")).toBe("unknown");
    expect(residentState(42)).toBe("unknown");
    expect(residentState(undefined)).toBe("unknown");
  });
});
