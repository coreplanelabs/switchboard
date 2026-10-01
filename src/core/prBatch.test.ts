import { describe, expect, it } from "vitest";
import { linkedPullRequestsOf, prBatchBindingOf } from "./prBatchBinding.js";

describe("typed PR batch binding", () => {
  it("finds link destinations across flattened bullets without reading labels or code", () => {
    const request =
      "review these: • <https://github.com/acme/cli/pull/120|CLI https://github.com/acme/hidden/pull/1> " +
      "• [API PR](https://github.com/acme/api/pull/3927) `https://github.com/acme/code/pull/2`\n" +
      "> https://github.com/acme/quoted/pull/3";
    expect(linkedPullRequestsOf(request).map((target) => target.url)).toEqual([
      "https://github.com/acme/cli/pull/120",
      "https://github.com/acme/api/pull/3927",
    ]);
  });

  it("binds exact cross-repository targets chosen by the operator", () => {
    const request = "ship these: • https://github.com/acme/cli/pull/120 • https://github.com/acme/api/pull/3927";
    expect(
      prBatchBindingOf(
        { kind: "ship", targets: ["https://github.com/acme/cli/pull/120", "https://github.com/acme/api/pull/3927"] },
        request,
      ),
    ).toEqual({
      binding: {
        kind: "ship",
        targets: [
          { repo: "acme/cli", number: 120, url: "https://github.com/acme/cli/pull/120" },
          { repo: "acme/api", number: 3927, url: "https://github.com/acme/api/pull/3927" },
        ],
      },
    });
  });

  it("binds a six-PR Markdown list across repositories without a command", () => {
    const urls = [
      "https://github.com/acme/api/pull/3911",
      "https://github.com/acme/api/pull/3913",
      "https://github.com/acme/provider/pull/20",
      "https://github.com/acme/api/pull/3915",
      "https://github.com/acme/api/pull/3917",
      "https://github.com/acme/api/pull/3918",
    ];
    const request = `<@U123> ship these\n\n${urls.map((url, index) => `- [PR ${index + 1} — title](${url})`).join("\n")}`;
    const result = prBatchBindingOf({ kind: "ship", targets: urls }, request);
    expect(result).toMatchObject({ binding: { kind: "ship", targets: urls.map((url) => ({ url })) } });
  });

  it("keeps re-review and ship-all wording for explicit batches", () => {
    const urls = ["https://github.com/acme/api/pull/7", "https://github.com/acme/web/pull/9"];
    for (const [kind, request] of [
      ["review", `re-review these: ${urls.join(" ")}`],
      ["ship", `ship all of these: ${urls.join(" ")}`],
    ] as const) {
      expect(prBatchBindingOf({ kind, targets: urls }, request)).toMatchObject({
        binding: { kind, targets: urls.map((url) => ({ url })) },
      });
    }
  });

  it("accepts a numbered Review list while keeping its exact order", () => {
    const urls = ["https://github.com/acme/api/pull/7", "https://github.com/acme/web/pull/9"];
    const request = `review these:\n1. [API](${urls[0]})\n2. [Web](${urls[1]})`;
    expect(prBatchBindingOf({ kind: "review", targets: urls }, request)).toMatchObject({
      binding: { kind: "review", targets: urls.map((url) => ({ url })) },
    });
  });

  it("refuses invented URL prefixes and targets present only in link labels", () => {
    expect(
      prBatchBindingOf(
        { kind: "ship", targets: ["https://github.com/acme/api/pull/1", "https://github.com/acme/web/pull/9"] },
        "ship these <https://github.com/acme/api/pull/10|https://github.com/acme/api/pull/1> and https://github.com/acme/web/pull/9",
      ),
    ).toEqual({ error: "a PR batch target must be an exact link in this request" });
  });

  it("keeps an excluded linked PR out of the selected Ship targets", () => {
    const request =
      "ship these: • https://github.com/acme/api/pull/7 • https://github.com/acme/web/pull/9; do not ship • https://github.com/acme/api/pull/10";
    expect(
      prBatchBindingOf(
        { kind: "ship", targets: ["https://github.com/acme/api/pull/7", "https://github.com/acme/web/pull/9"] },
        request,
      ),
    ).toEqual({
      binding: {
        kind: "ship",
        targets: [
          { repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7" },
          { repo: "acme/web", number: 9, url: "https://github.com/acme/web/pull/9" },
        ],
      },
    });
  });

  it("refuses a Ship action when the request explicitly asks for Review", () => {
    const request = "review these: https://github.com/acme/api/pull/7 https://github.com/acme/web/pull/9";
    expect(
      prBatchBindingOf(
        { kind: "ship", targets: ["https://github.com/acme/api/pull/7", "https://github.com/acme/web/pull/9"] },
        request,
      ),
    ).toEqual({ error: "a PR batch must match one explicit Review or Ship list in this request" });
  });

  it("refuses a negated or contextual PR even when its URL appears in the request", () => {
    const selected = ["https://github.com/acme/api/pull/7", "https://github.com/acme/web/pull/9"];
    for (const tail of ["do not ship", "for context"]) {
      const request = `ship these: https://github.com/acme/api/pull/7; ${tail} https://github.com/acme/web/pull/9`;
      expect(prBatchBindingOf({ kind: "ship", targets: selected }, request)).toEqual({
        error: "a PR batch must match one explicit Review or Ship list in this request",
      });
    }
  });

  it("refuses a PR with a postfix exclusion before granting Ship authority", () => {
    const urls = [
      "https://github.com/acme/api/pull/7",
      "https://github.com/acme/web/pull/9",
      "https://github.com/acme/cli/pull/13",
    ];
    for (const qualifier of ["(not for shipping)", "(for context)", "(hold this one)"]) {
      const request = `ship these: ${urls.join(" ")} ${qualifier}`;
      expect(prBatchBindingOf({ kind: "ship", targets: urls }, request)).toEqual({
        error: "a PR batch must match one explicit Review or Ship list in this request",
      });
    }
    expect(
      prBatchBindingOf({ kind: "ship", targets: urls }, `ship these: ${urls.join(" ")}. Not for shipping.`),
    ).toEqual({
      error: "a PR batch must match one explicit Review or Ship list in this request",
    });
  });

  it("refuses a partial selection from an explicit PR list", () => {
    const request =
      "ship these: https://github.com/acme/api/pull/7 https://github.com/acme/web/pull/9 https://github.com/acme/cli/pull/10";
    expect(
      prBatchBindingOf(
        { kind: "ship", targets: ["https://github.com/acme/api/pull/7", "https://github.com/acme/web/pull/9"] },
        request,
      ),
    ).toEqual({ error: "a PR batch must match one explicit Review or Ship list in this request" });
  });

  it("does not read a GitHub URL embedded after a pipe in a foreign bare URL", () => {
    const request =
      "ship these: https://github.com/acme/api/pull/7 https://evil.test/|https://github.com/acme/web/pull/9";
    expect(linkedPullRequestsOf(request).map((target) => target.url)).toEqual(["https://github.com/acme/api/pull/7"]);
    expect(
      prBatchBindingOf(
        { kind: "ship", targets: ["https://github.com/acme/api/pull/7", "https://github.com/acme/web/pull/9"] },
        request,
      ),
    ).toEqual({ error: "a PR batch target must be an exact link in this request" });
  });

  it("does not take action words from a foreign URL path", () => {
    const request =
      "http://evil.test/ship these: https://github.com/acme/api/pull/7 https://github.com/acme/web/pull/9";
    expect(
      prBatchBindingOf(
        { kind: "ship", targets: ["https://github.com/acme/api/pull/7", "https://github.com/acme/web/pull/9"] },
        request,
      ),
    ).toEqual({ error: "a PR batch must match one explicit Review or Ship list in this request" });
  });

  it("does not grant a PR whose link label explicitly excludes it", () => {
    const request =
      "ship these: [API](https://github.com/acme/api/pull/7) [Web](https://github.com/acme/web/pull/9) " +
      "[do not ship CLI](https://github.com/acme/cli/pull/10)";
    expect(
      prBatchBindingOf(
        {
          kind: "ship",
          targets: [
            "https://github.com/acme/api/pull/7",
            "https://github.com/acme/web/pull/9",
            "https://github.com/acme/cli/pull/10",
          ],
        },
        request,
      ),
    ).toEqual({ error: "a PR batch must match one explicit Review or Ship list in this request" });
  });

  it("does not turn a conditional mention of Ship into authorization", () => {
    const request =
      "review these links to decide whether to ship: https://github.com/acme/api/pull/7 https://github.com/acme/web/pull/9";
    expect(
      prBatchBindingOf(
        { kind: "ship", targets: ["https://github.com/acme/api/pull/7", "https://github.com/acme/web/pull/9"] },
        request,
      ),
    ).toEqual({ error: "a PR batch must match one explicit Review or Ship list in this request" });
  });

  it("does not use an inline quoted instruction as batch authority", () => {
    const request = '"ship these https://github.com/acme/api/pull/7 https://github.com/acme/web/pull/9"';
    expect(linkedPullRequestsOf(request)).toEqual([]);
  });

  it("refuses two positive actions or an unscoped PR after the list", () => {
    const selected = ["https://github.com/acme/api/pull/7", "https://github.com/acme/web/pull/9"];
    for (const request of [
      `review and ship these: ${selected.join(" ")}`,
      `ship these: ${selected.join(" ")}; https://github.com/acme/cli/pull/10`,
    ]) {
      expect(prBatchBindingOf({ kind: "ship", targets: selected }, request)).toEqual({
        error: "a PR batch must match one explicit Review or Ship list in this request",
      });
    }
  });
});
