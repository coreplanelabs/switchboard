import { describe, expect, it } from "vitest";
import {
  contextDependenciesContain,
  githubRepositoryDependencies,
  memoryScopeDependencies,
  contextDependenciesHash,
  contextDependenciesOf,
  isContextDependencies,
  mergeContextDependencies,
  UNKNOWN_CONTEXT_DEPENDENCIES,
  type ContextDependencies,
  type SourceReadReference,
} from "./contextDependencies.js";
import { addSourceReceipt, isSessionSources, mergeSessionSources, type SessionSources } from "./receipts.js";
import { testSessionSources } from "../testing/slackSources.js";

const mcp = (actionId: string, hash = "a".repeat(64)): SourceReadReference => ({
  runId: "run",
  actionId,
  callIds: ["call"],
  responseHash: hash,
});
const known = (refs: SourceReadReference[] = [], revision = 0): ContextDependencies => ({
  version: 1,
  status: "known",
  revision,
  origins: [],
  slack: [],
  mcp: refs,
});
const sources = () => testSessionSources({ channelId: "slack:C1", threadKey: "slack:C1:1.0", userId: "slack:U11" });

describe("whole-context dependencies", () => {
  it("keeps same-run native references in a versioned envelope and rejects downgrade or equivocation", async () => {
    const ref = { runId: "review", callId: "private-read", resultHash: "a".repeat(64), admissionHash: "b".repeat(64) };
    const scoped: ContextDependencies = { ...known(), version: 2, executionGithub: [ref] };
    expect(isContextDependencies(scoped)).toBe(true);
    expect(isContextDependencies({ ...scoped, version: 1 })).toBe(false);
    const merged = mergeContextDependencies(known(), scoped);
    expect(merged.version).toBe(2);
    expect(merged.executionGithub).toEqual([ref]);
    expect(contextDependenciesContain(merged, scoped)).toBe(true);
    expect(contextDependenciesContain(known(), scoped)).toBe(false);
    expect(
      mergeContextDependencies(scoped, { ...scoped, executionGithub: [{ ...ref, resultHash: "c".repeat(64) }] }).status,
    ).toBe("unknown");
    expect(await contextDependenciesHash(scoped)).not.toBe(await contextDependenciesHash(known()));
  });
  it("binds immutable coordinator status identities without treating their latest unit as the old observation", async () => {
    const ref = {
      instanceId: "plan-status",
      unit: "U11",
      attempt: 0,
      requester: "cli:user",
      channelId: "cli:main",
      threadKey: "cli:main:1",
      deliveryId: "U11/0/end",
      destinationThreadKey: "cli:main:1",
      repo: "acme/api",
      snapshotHash: "a".repeat(64),
    };
    const first = { ...known(), unitStatuses: [ref] };
    const second = mergeContextDependencies(first, {
      ...known(),
      unitStatuses: [{ ...ref, deliveryId: "U11/1/end", snapshotHash: "b".repeat(64) }],
    });
    expect(second.unitStatuses).toHaveLength(2);
    expect(contextDependenciesContain(second, first)).toBe(true);
    expect(contextDependenciesContain(known(), first)).toBe(false);
    expect(await contextDependenciesHash(first)).not.toBe(await contextDependenciesHash(known()));
    expect(
      mergeContextDependencies(first, { ...known(), unitStatuses: [{ ...ref, snapshotHash: "c".repeat(64) }] }),
    ).toMatchObject({ status: "unknown", reason: "equivocation" });
    expect(isContextDependencies({ ...known(), unitStatuses: [{ ...ref, snapshotHash: "invalid" }] })).toBe(false);
  });

  it("preserves a stronger canonical origin checkpoint and rejects conflicting checkpoints", () => {
    const origin = { runId: "run", requester: "cli:user", channelId: "cli:main", threadKey: "cli:main:1" };
    const plain = { ...known(), origins: [origin] };
    const checked = { ...known(), origins: [{ ...origin, checkpoint: "a".repeat(64) }] };
    const merged = mergeContextDependencies(plain, checked, plain);
    expect(merged.origins).toEqual(checked.origins);
    expect(contextDependenciesContain(merged, plain)).toBe(true);
    expect(contextDependenciesContain(plain, checked)).toBe(false);
    expect(
      mergeContextDependencies(checked, { ...known(), origins: [{ ...origin, checkpoint: "b".repeat(64) }] }),
    ).toMatchObject({ status: "unknown", reason: "equivocation" });
    expect(isContextDependencies({ ...known(), origins: [{ ...origin, checkpoint: "unproved" }] })).toBe(false);
  });

  it("preserves memory scope access independently of the original producer visibility", async () => {
    const scopes = memoryScopeDependencies(["user:slack:UA", "org:acme", "channel:slack:CA", "repo:acme/api"]);
    const merged = mergeContextDependencies(
      githubRepositoryDependencies(["acme/api"]),
      scopes,
      memoryScopeDependencies(["user:slack:UA"]),
    );
    expect(merged.memoryScopes).toEqual(["channel:slack:CA", "org:acme", "repo:acme/api", "user:slack:UA"]);
    expect(contextDependenciesContain(merged, scopes)).toBe(true);
    expect(contextDependenciesContain(known(), scopes)).toBe(false);
    expect(await contextDependenciesHash(known())).not.toBe(await contextDependenciesHash(scopes));
    expect(isContextDependencies({ ...known(), memoryScopes: ["user"] })).toBe(false);
    expect(memoryScopeDependencies(Array.from({ length: 257 }, (_, i) => `channel:slack:C${i}`))).toMatchObject({
      status: "unknown",
      reason: "overflow",
    });
  });

  it("preserves original repository access sets as one bounded leaf across transformations", async () => {
    const repos = Array.from({ length: 40 }, (_, i) => `acme/repo-${i}`);
    const catalog = githubRepositoryDependencies(repos);
    expect(catalog.status).toBe("known");
    expect(await contextDependenciesHash(known())).toBe(await contextDependenciesHash({ ...known(), githubRepos: [] }));
    const merged = mergeContextDependencies(
      known([mcp("source")]),
      catalog,
      githubRepositoryDependencies(["ACME/REPO-1", "acme/new"]),
    );
    expect(merged.githubRepos).toHaveLength(41);
    expect(contextDependenciesContain(merged, catalog)).toBe(true);
    expect(contextDependenciesContain(known(), catalog)).toBe(false);
    expect(await contextDependenciesHash(catalog)).toBe(
      await contextDependenciesHash(githubRepositoryDependencies([...repos].reverse())),
    );
    expect(await contextDependenciesHash(catalog)).not.toBe(
      await contextDependenciesHash(githubRepositoryDependencies(["acme/changed"])),
    );
    expect(isContextDependencies({ ...known(), githubRepos: ["not a canonical repository"] })).toBe(false);
    const overflow = githubRepositoryDependencies(Array.from({ length: 257 }, (_, i) => `acme/repo-${i}`));
    expect(overflow).toMatchObject({ status: "unknown", reason: "overflow" });
    expect(isContextDependencies(overflow)).toBe(true);
    expect(mergeContextDependencies(overflow, known()).status).toBe("unknown");
  });

  it("unions original leaves across several handoffs without relabeling their audiences", () => {
    const original = sources();
    if (original.status !== "known") throw new Error("fixture");
    const first = { ...known([mcp("first")]), slack: original.receipts };
    const second = mergeContextDependencies(known([mcp("second")]), first);
    const third = mergeContextDependencies(known([mcp("third")]), second);
    expect(third.status).toBe("known");
    expect(third.mcp.map((r) => r.actionId)).toEqual(["first", "second", "third"]);
    expect(third.slack).toEqual(original.receipts);
    expect(third.revision).toBeGreaterThan(second.revision);
    expect(contextDependenciesContain(third, first)).toBe(true);
    expect(mergeContextDependencies(third, first)).toEqual(third);
  });

  it("treats legacy absence as unknown and never heals unknown or revoked context", () => {
    expect(contextDependenciesOf(undefined)).toEqual(UNKNOWN_CONTEXT_DEPENDENCIES);
    expect(contextDependenciesOf(sources())).toEqual(UNKNOWN_CONTEXT_DEPENDENCIES);
    const unknown = mergeContextDependencies(undefined, known([mcp("first")]));
    expect(unknown.status).toBe("unknown");
    expect(mergeContextDependencies(unknown, known([mcp("second")])).status).toBe("unknown");
    const revoked = mergeContextDependencies({ ...known(), status: "revoked" }, unknown);
    expect(revoked.status).toBe("revoked");
    expect(mergeContextDependencies(revoked, known()).status).toBe("revoked");
    expect(contextDependenciesContain(unknown, known())).toBe(false);
  });

  it("marks same-action response or call identity changes as equivocation", () => {
    for (const changed of [mcp("first", "b".repeat(64)), { ...mcp("first"), callIds: ["other"] }]) {
      const result = mergeContextDependencies(known([mcp("first")]), known([changed]));
      expect(result).toMatchObject({ status: "unknown", reason: "equivocation" });
      expect(result.mcp).toEqual([mcp("first")]);
    }
  });

  it("refuses changed source message evidence even when it arrives in a different receipt", () => {
    const state = sources();
    if (state.status !== "known") throw new Error("fixture");
    const receipt = state.receipts[0]!;
    const changed = {
      ...receipt,
      readKind: "nearby" as const,
      messages: receipt.messages.map((m) => ({ ...m, hash: "f".repeat(64) })),
    };
    expect(mergeContextDependencies({ ...known(), slack: [receipt] }, { ...known(), slack: [changed] })).toMatchObject({
      status: "unknown",
      reason: "equivocation",
    });
  });

  it("preserves direct private producer origins and refuses relabeled run identities", () => {
    const origin = { runId: "private-run", requester: "slack:U11", channelId: "slack:D1", threadKey: "slack:D1:1.0" };
    const first = { ...known(), origins: [origin] };
    const second = mergeContextDependencies(known([mcp("next")]), first);
    expect(second.origins).toEqual([origin]);
    expect(
      mergeContextDependencies(first, { ...known(), origins: [{ ...origin, channelId: "slack:C2" }] }),
    ).toMatchObject({ status: "unknown", reason: "equivocation" });
  });

  it("reports bounded overflow and keeps the already retained dependency references", () => {
    const prior = known(Array.from({ length: 32 }, (_, i) => mcp(`action-${String(i).padStart(2, "0")}`)));
    const result = mergeContextDependencies(prior, known([mcp("overflow")]));
    expect(result).toMatchObject({ status: "unknown", reason: "overflow" });
    expect(result.mcp).toEqual(prior.mcp);
    expect(isContextDependencies(result)).toBe(true);
    expect(isContextDependencies({ ...prior, mcp: [...prior.mcp, mcp("overflow")] })).toBe(false);
  });

  it("keeps taint metadata inside the byte bound even when the previous envelope was full", () => {
    const refs = Array.from({ length: 32 }, (_, i) => mcp(`action-${i}`));
    const prior = known(refs);
    for (const ref of refs) {
      for (const field of ["runId", "actionId"] as const) {
        const room = 16 * 1024 - 1 - new TextEncoder().encode(JSON.stringify(prior)).byteLength;
        if (room > 0) ref[field] += "x".repeat(Math.min(256 - ref[field].length, room));
      }
      const room = 16 * 1024 - 1 - new TextEncoder().encode(JSON.stringify(prior)).byteLength;
      if (room > 0) ref.callIds[0] += "x".repeat(Math.min(256 - ref.callIds[0].length, room));
    }
    expect(isContextDependencies(prior)).toBe(true);
    const next = mergeContextDependencies(prior, UNKNOWN_CONTEXT_DEPENDENCIES);
    expect(next).toMatchObject({ status: "unknown", reason: "overflow" });
    expect(isContextDependencies(next)).toBe(true);
  });

  it("binds snapshots by canonical hash and monotone revision, independent of object field order", async () => {
    const first = known([mcp("first")]);
    const reordered = {
      origins: first.origins,
      mcp: first.mcp,
      slack: first.slack,
      revision: 0,
      status: "known",
      version: 1,
    } as ContextDependencies;
    expect(await contextDependenciesHash(first)).toBe(await contextDependenciesHash(reordered));
    const second = mergeContextDependencies(first, known([mcp("second")]));
    expect(await contextDependenciesHash(first)).not.toBe(await contextDependenciesHash(second));
    expect(contextDependenciesContain(first, second)).toBe(false);
    expect(contextDependenciesContain({ ...second, revision: 0 }, { ...first, revision: 1 })).toBe(false);
    expect(isContextDependencies({ ...first, revision: -1 })).toBe(false);
  });

  it("includes new direct Slack reads in existing whole-context metadata", () => {
    const base = sources();
    if (base.status !== "known") throw new Error("fixture");
    const next = addSourceReceipt({ ...base, receipts: [], context: known() }, base.receipts[0]!);
    expect(contextDependenciesOf(next).slack).toEqual(base.receipts);
  });

  it("uses the existing source metadata merge and preserves taint across older writers", () => {
    const base = sources();
    const first: SessionSources = { ...base, context: known([mcp("first")]) };
    const next: SessionSources = { ...base, context: known([mcp("second")]) };
    const merged = mergeSessionSources(first, next, false);
    expect(isSessionSources(merged)).toBe(true);
    expect(contextDependenciesOf(merged).mcp).toHaveLength(2);
    expect(contextDependenciesOf(mergeSessionSources(merged, base, false)).status).toBe("unknown");
    expect(contextDependenciesOf(mergeSessionSources(undefined, first, true)).status).toBe("known");
    expect(contextDependenciesOf(mergeSessionSources(undefined, first, false)).status).toBe("unknown");
    expect(contextDependenciesOf(mergeSessionSources(first, { version: 1, status: "revoked" }, false)).status).toBe(
      "revoked",
    );
  });
});
