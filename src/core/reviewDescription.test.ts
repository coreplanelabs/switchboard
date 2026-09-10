import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePrDescription, renderPrDescriptionMarkdown } from "./prDescription.js";
import { submittedPrDescriptionArtifact } from "./reviewDescription.js";

// Feature: docs/reference/specs/reading-diff.md item 7 — the PR's description as data on
// the run stream. The `submitted` builder turns the typed object a coding run
// submitted into the artifact the post-step publishes beside `pr_opened`:
// exact and complete, every anchor stamped with the head the body was
// rendered at, every string leaf sanitized like the reading diff.

const HEAD = "685c471f31feaadd725fb917b68a2eea31c0f81a";
const golden = () =>
  parsePrDescription(
    JSON.parse(readFileSync(new URL("./testing/goldenTour.description.json", import.meta.url), "utf8")),
  );

describe("submittedPrDescriptionArtifact", () => {
  it("carries the golden's title, tldr, tour (anchors stamped with the render sha), remaining and decisions plus the rendered body; complete, no problems, not truncated", () => {
    const desc = golden();
    const body = renderPrDescriptionMarkdown(desc, { repo: "acme/api", headSha: HEAD });
    const a = submittedPrDescriptionArtifact(desc, { repo: "acme/api", pr: 329, headSha: HEAD, body });
    expect(a).toEqual({
      artifact: "pr_description",
      origin: "submitted",
      repo: "acme/api",
      pr: 329,
      headSha: HEAD,
      title: desc.title,
      body,
      tldr: desc.tldr,
      tour: desc.tour.map((s) => ({ ...s, anchor: { ...s.anchor, sha: HEAD } })),
      remaining: desc.remaining,
      decisions: desc.decisions,
      complete: true,
      problems: [],
      truncated: false,
    });
  });

  it("every string leaf is control-stripped and redacted — the title, a step's prose, an anchor path, a decision and the body alike; numbers ride unchanged", () => {
    const token = `ghp_${"a".repeat(30)}`;
    const desc = {
      ...golden(),
      title: `Rotate ${token}`,
      tour: [
        {
          title: "The fix",
          description: `[32mgreen[0m uses ${token}`,
          anchor: { path: `src/${token}.ts`, from: 1, to: 2 },
        },
      ],
      decisions: [{ title: "Keep it", rationale: `Authorization: Bearer ${token}` }],
    };
    const body = renderPrDescriptionMarkdown(desc, { repo: "acme/api", headSha: HEAD });
    const a = submittedPrDescriptionArtifact(desc, { repo: "acme/api", pr: 1, headSha: HEAD, body });
    const json = JSON.stringify(a);
    expect(json).not.toContain(token);
    expect(json).not.toContain("");
    expect(a.title).toBe("Rotate «redacted-github-token»");
    expect(a.tour[0].description).toBe("green uses «redacted-github-token»");
    expect(a.tour[0].anchor).toEqual({ path: "src/«redacted-github-token».ts", from: 1, to: 2, sha: HEAD });
    expect(a.decisions[0].rationale).toContain("«redacted»");
    expect(a.body).toContain("«redacted-github-token»");
  });
});
