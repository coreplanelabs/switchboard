import { describe, expect, it } from "vitest";
import type { ChildHandoff } from "../dispatch/handoff.js";
import { contextReferencesOf, retainContextSources } from "./contextRetention.js";

describe("context retention — bounded references follow their live holders", () => {
  it("pins the exact original and execution sources of a retained native media dependency", () => {
    const context = {
      version: 3 as const,
      status: "known" as const,
      revision: 1,
      origins: [],
      slack: [],
      mcp: [],
      nativeMediaSources: [
        {
          executionRunId: "source-B",
          executionSequence: 2,
          reference: {
            version: 1 as const,
            kind: "confirmed" as const,
            sourceRunId: "source-A",
            sourceSequence: 1,
            sourceDigest: "a".repeat(64),
            confirmationId: "saved-choice",
            intentDigest: "b".repeat(64),
          },
        },
      ],
    };
    const refs = contextReferencesOf("consumer-C", undefined, context);
    expect(refs).toEqual([
      { holderRunId: "consumer-C", sourceRunId: "source-A" },
      { holderRunId: "consumer-C", sourceRunId: "source-B" },
    ]);
    const items = ["source-A", "source-B", "consumer-C", "unrelated"].map((id) => ({ id }));
    expect(retainContextSources(items, [items[2]!], refs).map((row) => row.id)).toEqual([
      "source-A",
      "source-B",
      "consumer-C",
    ]);
    expect(retainContextSources(items, [], refs)).toEqual([]);
  });
  const ref = (holderRunId: string, sourceRunId: string) => ({ holderRunId, sourceRunId });
  it("keeps existing dependencies of ordinary retained and live holders until those holders retire", () => {
    const items = ["old-source", "live-source", "child", "unrelated"].map((id) => ({ id }));
    const refs = [ref("child", "old-source"), ref("live-child", "live-source")];
    expect(retainContextSources(items, [items[2]], refs, ["live-child"]).map((r) => r.id)).toEqual([
      "old-source",
      "live-source",
      "child",
    ]);
    expect(retainContextSources(items, [], refs, []).map((r) => r.id)).toEqual([]);
  });

  it("never resurrects a deleted source or recursively promotes a pinned record into another holder", () => {
    const items = ["child", "parent", "unneeded-ancestor"].map((id) => ({ id }));
    const refs = [ref("child", "parent"), ref("child", "deleted"), ref("parent", "unneeded-ancestor")];
    expect(retainContextSources(items, [items[0]], refs).map((r) => r.id)).toEqual(["child", "parent"]);
  });

  it("pins original producer runs from a finished context without requiring a child handoff", () => {
    const context = {
      version: 1 as const,
      status: "known" as const,
      revision: 0,
      origins: [{ runId: "origin", requester: "slack:U11", channelId: "slack:C1", threadKey: "slack:C1:1.0" }],
      slack: [],
      mcp: [],
    };
    expect(contextReferencesOf("holder", undefined, context)).toEqual([
      { holderRunId: "holder", sourceRunId: "origin" },
    ]);
    expect(contextReferencesOf("origin", undefined, context)).toEqual([]);
  });

  it("indexes each frozen source session, source read, note snapshot and artifact producer", () => {
    const handoff: ChildHandoff = {
      version: 1,
      source: { runId: "parent", requester: "slack:U11", channelId: "slack:C1", threadKey: "slack:C1:1.0" },
      session: { key: "slack:C1:1.0:coding", from: 0, to: 4 },
      snapshotRunId: "note-snapshot",
      dependencies: {
        hash: "b".repeat(64),
        value: {
          version: 1,
          status: "known",
          revision: 0,
          origins: [
            { runId: "private-origin", requester: "slack:U11", channelId: "slack:D1", threadKey: "slack:D1:1.0" },
          ],
          slack: [],
          mcp: [{ runId: "compacted-read", actionId: "action", callIds: ["call"], responseHash: "c".repeat(64) }],
        },
      },
      assets: [
        {
          key: "asset",
          name: "report.pdf",
          contentType: "application/pdf",
          size: 1,
          runId: "artifact-run",
          direction: "out",
        },
      ],
      assetRuns: [{ runId: "catalogue-run" }],
    };
    const refs = contextReferencesOf("child", handoff);
    expect(refs).toContainEqual({ holderRunId: "child", sourceRunId: "parent", sessionKey: handoff.session.key });
    expect(new Set(refs.map((r) => r.sourceRunId))).toEqual(
      new Set(["parent", "note-snapshot", "artifact-run", "catalogue-run", "private-origin", "compacted-read"]),
    );
  });
});
