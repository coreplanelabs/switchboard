// Feature: docs/reference/specs/resident-repos.md item 62 — resident-supplied text is made
// safe at the seams: the resident sanitizes at the write and the exit, the bot
// at the parse, so no card, reply, listing or record shows raw remote output.
import { describe, expect, it } from "vitest";
import {
  RESIDENT_ERROR_CAP,
  RESIDENT_TEXT_CAP,
  residentState,
  residentText,
  sanitizeResidentBody,
} from "./residentText.js";

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

// The onboard refusal as the resident builds it (resident-repos item 35): the two
// causes, the admin action and GitHub's own 422 body after them — ~600 chars,
// twice the card-sized cap. It is a full reply, and every word past the first
// 300 is the part that tells the admin what to do.
const ONBOARD_REFUSAL =
  "not-in-installation: the GitHub App cannot mint a token scoped to repo:acme/polyplane-k8s — " +
  "the repository is not in the App installation's repository list, or does not exist under that exact name " +
  "(GitHub's token API answers the same 422 for both). An org admin adds it under the App's installation settings " +
  "(Settings → GitHub Apps → Configure → Repository access), then retry (github-token-mint-failed: HTTP 422 " +
  '{"message":"There is at least one repository that does not exist","documentation_url":' +
  '"https://docs.github.com/rest/apps/apps#create-an-installation-access-token-for-an-app","status":"422"})';

describe("sanitizeResidentBody — an error is a reply, a reason is a card note", () => {
  it("keeps the onboard refusal whole, admin action and 422 tail included, up to RESIDENT_ERROR_CAP", () => {
    expect(ONBOARD_REFUSAL.length).toBeGreaterThan(RESIDENT_TEXT_CAP);
    const out = sanitizeResidentBody({ error: ONBOARD_REFUSAL });
    expect(out.error).toBe(ONBOARD_REFUSAL);
    expect(out.error).toContain("Repository access");
    expect(out.error).toContain("HTTP 422");
    expect(sanitizeResidentBody({ error: "x".repeat(RESIDENT_ERROR_CAP + 50) }).error).toHaveLength(
      RESIDENT_ERROR_CAP + 1,
    );
  });

  it("still strips, redacts and bounds an error — the wider cap is a size bound, not an exemption", () => {
    const out = sanitizeResidentBody({ error: POISON });
    expect(out.error).not.toContain("\x1b");
    expect(out.error).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out.error).toContain("«redacted");
  });

  it("caps reason and summary at RESIDENT_TEXT_CAP — they land in card notes and `repo list` rows", () => {
    const out = sanitizeResidentBody({ reason: ONBOARD_REFUSAL, summary: ONBOARD_REFUSAL });
    expect(out.reason).toHaveLength(RESIDENT_TEXT_CAP + 1);
    expect(out.reason.endsWith("…")).toBe(true);
    expect(out.summary).toHaveLength(RESIDENT_TEXT_CAP + 1);
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
