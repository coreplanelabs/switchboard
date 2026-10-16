import { describe, expect, it } from "vitest";
import { githubPullSourceContextOf, githubSourceContextForTask } from "./githubReadSource.js";

describe("GitHub task source context", () => {
  const context = {
    version: 1,
    source: { host: "github.com", appId: 1, installationId: 2 },
    repositoryId: 11,
    pullRequestId: 101,
    number: 7,
    head: { repositoryId: 22, ref: "fix/retry", sha: "a".repeat(40) },
    baseRef: "main",
  };

  it("retains a closed source snapshot across JSON without granting requester or routing authority", () => {
    expect(githubPullSourceContextOf(JSON.parse(JSON.stringify(context)))).toEqual(context);
    for (const extra of [{ requester: "admin" }, { targetRunId: "worker" }, { permission: "write" }])
      expect(githubPullSourceContextOf({ ...context, ...extra })).toBeUndefined();
  });

  it("holds incomplete or malformed native identity and preserves an explicitly deleted fork", () => {
    for (const changed of [
      { source: undefined },
      { source: { ...context.source, installationId: 0 } },
      { repositoryId: "11" },
      { pullRequestId: undefined },
      { number: -1 },
      { head: { ...context.head, repositoryId: undefined } },
      { head: { ...context.head, sha: "unknown" } },
      { baseRef: "" },
    ])
      expect(githubPullSourceContextOf({ ...context, ...changed })).toBeUndefined();
    expect(githubPullSourceContextOf({ ...context, head: { ...context.head, repositoryId: null } })).toEqual({
      ...context,
      head: { ...context.head, repositoryId: null },
    });
  });

  it("refuses a snapshot for another task before saving it", () => {
    expect(githubSourceContextForTask(context, 7)).toEqual(context);
    expect(() => githubSourceContextForTask(context, 8)).toThrow(
      "GitHub source context does not match the resolved task.",
    );
    expect(githubSourceContextForTask(undefined, 7)).toBeUndefined();
    expect(() => githubSourceContextForTask(null, 7)).toThrow(
      "GitHub source context does not match the resolved task.",
    );
  });
});
