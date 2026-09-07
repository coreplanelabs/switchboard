import { describe, expect, it } from "vitest";
import { commentBody, FOOTER, MARKER, summaryBlock } from "../scripts/deploy-targets.mjs";

// The `deploy targets` CI job's two rendered artifacts (features/release-and-
// deploy.md item 8). The command it wraps (`deploy plan --affected`) has its
// own tests; what matters here is the exact shape the job summary and the
// release PR's sticky comment take, since the comment is found again by its
// first line.

describe("deploy-targets renderings", () => {
  const table = "| Worker | Decision |\n|---|---|\n| bot | deploy |";

  it("titles the job summary for a PR by what its diff would deploy", () => {
    expect(summaryBlock(false, table)).toBe(`## What this PR's diff would deploy\n\n${table}\n`);
  });

  it("titles the job summary for the release PR by what merging it deploys", () => {
    expect(summaryBlock(true, table)).toBe(`## What merging this release deploys\n\n${table}\n`);
  });

  it("starts the sticky comment with the marker so the next run can find and replace it", () => {
    const body = commentBody(table);
    expect(body.startsWith(`${MARKER}\n`)).toBe(true);
    expect(MARKER).toBe("<!-- switchboard:deploy-targets -->");
  });

  it("carries the table and the footer that says how it is refreshed and what merging does", () => {
    const body = commentBody(table);
    expect(body).toContain(table);
    expect(body.trimEnd().endsWith(FOOTER)).toBe(true);
    expect(FOOTER).toContain("deploy all --affected");
  });
});
