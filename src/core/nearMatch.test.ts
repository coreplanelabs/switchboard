import { describe, expect, it } from "vitest";
import { editBudget, editDistance, nearMatch } from "./nearMatch.js";

// Feature: record 0054, the repository guesses:
// one deterministic "did you mean" over a list the bot holds — a unique
// candidate within a prefix or an edit budget is the guess; two tie and are
// listed with none proposed; an exact name is never a typo.

describe("nearMatch — one deterministic guess over a known list", () => {
  it("guesses the one candidate the typed name is a prefix of", () => {
    expect(nearMatch("acme/infra", ["acme/infrastructure", "acme/api"])).toMatchObject({
      guess: "acme/infrastructure",
      reason: "`acme/infrastructure` extends the name",
    });
  });

  it("words the prefix reason per direction when the typed name extends the candidate", () => {
    expect(nearMatch("acme/apix", ["acme/api", "acme/web"])).toMatchObject({
      guess: "acme/api",
      reason: "the name extends `acme/api`",
    });
  });

  it("lists two candidates when two are within budget, and proposes none", () => {
    const found = nearMatch("acme/api", ["acme/api-gateway", "acme/api-docs", "acme/web"]);
    expect(found.guess).toBeUndefined();
    expect(found.candidates).toEqual(["acme/api-gateway", "acme/api-docs"]);
  });

  it("never treats an exact name as a typo, even beside close names", () => {
    expect(nearMatch("acme/infrastructure", ["acme/infrastructure", "acme/infrastructure-2"])).toEqual({});
  });

  it("keeps the candidates' own spelling in the guess", () => {
    expect(nearMatch("Acme/Infra", ["Acme/Infrastructure"])).toMatchObject({ guess: "Acme/Infrastructure" });
  });

  it("spends one edit on a three-letter name and two on a nine-letter one", () => {
    expect(editBudget("api")).toBe(1);
    expect(editBudget("acme/infra")).toBe(2);
    // one edit from `api` → the guess …
    expect(nearMatch("api", ["apl", "web"])).toMatchObject({ guess: "apl" });
    // … two edits are past a three-letter name's budget.
    expect(nearMatch("api", ["axl", "web"])).toEqual({});
    // a nine-letter name affords two edits.
    expect(nearMatch("webclient", ["webcllent"])).toMatchObject({
      guess: "webcllent",
      reason: "one edit from `webcllent`",
    });
    expect(nearMatch("webclient", ["webcllenx"])).toMatchObject({
      guess: "webcllenx",
      reason: "two edits from `webcllenx`",
    });
  });

  it("measures the edits the reason names", () => {
    expect(editDistance("infra", "infrastructure")).toBe(9);
    expect(nearMatch("infra", ["infrastructure"])).toMatchObject({ guess: "infrastructure" });
  });

  it("answers nothing when no candidate is within budget", () => {
    expect(nearMatch("acme/infra", ["acme/api", "acme/web"])).toEqual({});
  });

  it("is deterministic and case-insensitive over the inventory's names", () => {
    const residents = ["acme/infrastructure", "acme/api", "acme/product", "acme/infra-tools"];
    // `acme/infra` shares its prefix with two residents → both listed, none proposed.
    expect(nearMatch("acme/infra", residents)).toMatchObject({
      candidates: ["acme/infrastructure", "acme/infra-tools"],
    });
    expect(nearMatch("ACME/PRODUCT", residents)).toEqual({});
  });
});
