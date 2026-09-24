import { describe, expect, it } from "vitest";
import type { PullRequestFacts } from "../execution/githubPulls.js";
import type { ExistingPrPublicationBinding } from "./coordinator/contract.js";
import { verifyExistingPrPublication } from "./existingPrPublication.js";

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const UNIT = `U${1}`;
const OWNER = { instanceId: "plan-fix", unit: UNIT };
const binding = (over: Partial<ExistingPrPublicationBinding> = {}): ExistingPrPublicationBinding => ({
  repo: "acme/api",
  pr: 7,
  headRef: "fix/existing",
  baseRef: "main",
  expectedHeadSha: HEAD,
  publicationRef: "fix/existing",
  owner: OWNER,
  ...over,
});
const facts = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  state: "open",
  headRef: "fix/existing",
  baseRef: "main",
  headSha: HEAD,
  sameRepoHead: true,
  headBranchExists: true,
  ...over,
});
const context = (over: Record<string, unknown> = {}) => ({
  repo: "acme/api",
  pr: 7,
  ref: "fix/existing",
  baseRef: "main",
  requestHeadSha: HEAD,
  workspaceRef: "fix/existing",
  workspaceHeadSha: HEAD,
  owner: OWNER,
  ...over,
});

describe("verifyExistingPrPublication — exact existing-PR publication binding", () => {
  it("allows the exact same-head binding and returns the atomic lease the push must carry", () => {
    expect(verifyExistingPrPublication(binding(), context(), facts())).toEqual({
      ok: true,
      publication: { ref: "fix/existing", expectedHeadSha: HEAD },
    });
  });

  it.each([
    ["missing durable binding", undefined, context(), facts()],
    ["short expected SHA", binding({ expectedHeadSha: "aaaaaaa" }), context(), facts()],
    ["repository mismatch", binding(), context({ repo: "acme/web" }), facts()],
    ["pull request mismatch", binding(), context({ pr: 8 }), facts()],
    ["head ref mismatch", binding(), context({ ref: "fix/other" }), facts()],
    ["base ref mismatch", binding(), context({ baseRef: "release" }), facts()],
    ["request head missing", binding(), context({ requestHeadSha: undefined }), facts()],
    ["request head mismatch", binding(), context({ requestHeadSha: MOVED }), facts()],
    ["publication ref mismatch", binding(), context({ workspaceRef: "fix/other" }), facts()],
    ["workspace head missing", binding(), context({ workspaceHeadSha: undefined }), facts()],
    ["workspace head mismatch", binding(), context({ workspaceHeadSha: MOVED }), facts()],
    ["ownership changed", binding(), context({ owner: { instanceId: "plan-other", unit: UNIT } }), facts()],
    ["remote read unavailable", binding(), context(), undefined],
    ["pull request closed", binding(), context(), facts({ state: "closed" })],
    ["foreign head repository", binding(), context(), facts({ sameRepoHead: false })],
    ["remote head ref moved", binding(), context(), facts({ headRef: "fix/other" })],
    ["remote base ref moved", binding(), context(), facts({ baseRef: "release" })],
    ["remote head branch missing", binding(), context(), facts({ headBranchExists: false })],
    ["remote head moved", binding(), context(), facts({ headSha: MOVED })],
  ])("fails closed for %s", (_label, durable, local, remote) => {
    expect(verifyExistingPrPublication(durable, local, remote)).toMatchObject({ ok: false });
  });
});
