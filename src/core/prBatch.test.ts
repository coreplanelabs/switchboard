import { describe, expect, it } from "vitest";
import { prBatchBindingOf } from "./prBatchBinding.js";

const api = "https://github.com/acme/api/pull/7";
const web = "https://github.com/acme/web/pull/9";
const urls = [api, web];
const claim = (kind: "review" | "ship", actionQuote: string, targets = urls, targetQuotes = targets) => ({
  kind,
  targets,
  actionQuote,
  targetQuotes,
});

describe("typed PR batch binding", () => {
  it("binds exact cross-repository targets and keeps authored evidence", () => {
    const request = `ship these: • ${api} • ${web}`;
    expect(prBatchBindingOf(claim("ship", "ship these"), request)).toEqual({
      binding: {
        kind: "ship",
        targets: [
          { repo: "acme/api", number: 7, url: api },
          { repo: "acme/web", number: 9, url: web },
        ],
        evidence: { action: "ship these", targets: urls },
      },
    });
  });

  it("accepts exact link destinations in Markdown and Slack markup without reading labels", () => {
    const request = `review these: [API](${api}) <${web}|Web>`;
    expect(prBatchBindingOf(claim("review", "review these"), request)).toMatchObject({
      binding: { kind: "review", targets: [{ url: api }, { url: web }] },
    });
  });

  it("requires action and every complete target span in the author's request", () => {
    const request = `ship these: ${api} ${web}`;
    expect(prBatchBindingOf(claim("ship", "ship all"), request)).toEqual({
      error: "a PR batch action needs a complete authored span",
    });
    expect(prBatchBindingOf(claim("ship", "ship these", urls, [api, web.slice(0, -1)]), request)).toEqual({
      error: "a PR batch target must have its complete exact link in this request",
    });
    expect(prBatchBindingOf(claim("ship", "ship these", [api, "https://github.com/acme/cli/pull/3"]), request)).toEqual(
      {
        error: "a PR batch target must have its complete exact link in this request",
      },
    );
  });

  it("rejects duplicate and wrong-canonical PR targets", () => {
    const request = `ship these: ${api} ${web}`;
    expect(prBatchBindingOf(claim("ship", "ship these", [api, api]), request)).toEqual({
      error: "a PR batch cannot repeat a target",
    });
    expect(prBatchBindingOf(claim("ship", "ship these", [api, web], [api, api]), request)).toEqual({
      error: "a PR batch target must have its complete exact link in this request",
    });
  });

  it("does not treat a GitHub-looking suffix inside a foreign URL as a linked target", () => {
    const request = `ship these: ${api} https://evil.test/|${web}`;
    expect(prBatchBindingOf(claim("ship", "ship these"), request)).toEqual({
      error: "a PR batch target must have its complete exact link in this request",
    });
  });

  it("does not let Review words authorize a typed Ship batch", () => {
    const request = `review these: ${api} ${web}`;
    expect(prBatchBindingOf(claim("ship", "review"), request)).toEqual({
      error: "a PR batch action needs a complete authored span",
    });
    expect(prBatchBindingOf(claim("ship", "friendship"), `review our friendship: ${api} ${web}`)).toEqual({
      error: "a PR batch action needs a complete authored span",
    });
  });

  it("leaves exclusions and conditional wording to the operator's typed decision", () => {
    const request = `review ${api} and ${web} to decide whether to ship them`;
    expect(prBatchBindingOf(claim("review", "review", urls), request)).toMatchObject({
      binding: { kind: "review", targets: [{ url: api }, { url: web }] },
    });
  });
});
