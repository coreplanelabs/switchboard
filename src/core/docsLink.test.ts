import { describe, expect, it } from "vitest";
import { PROJECT_DOCS_URL, docsRedirectTarget } from "./docsLink.js";

describe("docsRedirectTarget", () => {
  it("sends /docs to the docs site's home", () => {
    expect(docsRedirectTarget("/docs")).toBe(`${PROJECT_DOCS_URL}/`);
    expect(docsRedirectTarget("/docs/")).toBe(`${PROJECT_DOCS_URL}/`);
  });

  it("carries a deep link across unchanged, so a docs URL can be shared", () => {
    expect(docsRedirectTarget("/docs/reference/cli")).toBe(`${PROJECT_DOCS_URL}/reference/cli`);
    expect(docsRedirectTarget("/docs/how-to/onboard-a-repo")).toBe(`${PROJECT_DOCS_URL}/how-to/onboard-a-repo`);
  });

  it("honours an overridden base (local development) without doubling the slash", () => {
    expect(docsRedirectTarget("/docs/reference/cli", "http://localhost:5173")).toBe(
      "http://localhost:5173/reference/cli",
    );
    expect(docsRedirectTarget("/docs", "http://localhost:5173/")).toBe("http://localhost:5173/");
  });

  it("claims no path outside /docs — including one that merely starts with the word", () => {
    for (const path of ["/", "/runs", "/docsomething", "/healthz", "/api/help.show", ""]) {
      expect(docsRedirectTarget(path)).toBeUndefined();
    }
  });

  it("cannot be steered off the configured origin", () => {
    // A doubled slash would otherwise render as `https://host//evil.example`,
    // and a leading-slash tail is the shape a protocol-relative URL needs.
    expect(docsRedirectTarget("/docs//evil.example")).toBe(`${PROJECT_DOCS_URL}/evil.example`);
    expect(docsRedirectTarget("/docs/../runs")).toBe(`${PROJECT_DOCS_URL}/../runs`);
  });
});
