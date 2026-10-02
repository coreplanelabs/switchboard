import { describe, expect, it } from "vitest";
import { contextCapsuleOf, isUnitContext, UNIT_CONTEXT_MAX_BYTES } from "./unitContext.js";
import { snapshotNotepad, type ChildHandoff } from "./handoff.js";
import { contextDependenciesHash, githubRepositoryDependencies } from "../references/contextDependencies.js";
import { NOTEPAD_MAX_BYTES } from "../runLedger/sessionLog.js";

const snapshot: ChildHandoff = {
  version: 1,
  source: { runId: "parent", requester: "cli:user", channelId: "cli:main", threadKey: "cli:main:1" },
  session: { key: "cli:main:1:@thread", from: 0, to: -1 },
  assets: [],
};

describe("coordinator context capsule", () => {
  it("keeps a valid full notepad beside a large source envelope within the unit metadata budget", async () => {
    const dependencies = githubRepositoryDependencies(
      Array.from({ length: 64 }, (_, i) => `acme/${"r".repeat(200)}${i}`),
    );
    expect(dependencies.status).toBe("known");
    const notepad = await snapshotNotepad({ text: "n".repeat(NOTEPAD_MAX_BYTES), updatedAt: 1 });
    const capsule = contextCapsuleOf({
      ...snapshot,
      notepad,
      dependencies: { value: dependencies, hash: await contextDependenciesHash(dependencies) },
    });
    expect(capsule.handoff.notepad).toEqual(notepad);
    expect(capsule.handoff.dependencies?.value).toEqual(dependencies);
    expect(new TextEncoder().encode(JSON.stringify(capsule)).byteLength).toBeLessThanOrEqual(32 * 1024);
  });

  it("bounds the original snapshot without discarding unrecoverable notes or accepting a child binding", async () => {
    const assets = Array.from({ length: 200 }, (_, seq) => ({
      key: `runs/parent/${"a".repeat(160)}${seq}`,
      name: "source.pdf",
      runId: "parent",
      seq,
      direction: "in" as const,
      contentType: "application/pdf",
      size: 10,
    }));
    const capsule = contextCapsuleOf({ ...snapshot, assets });
    expect(isUnitContext(capsule)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(capsule)).byteLength).toBeLessThanOrEqual(UNIT_CONTEXT_MAX_BYTES);
    expect(capsule.handoff.assetRuns).toEqual([{ runId: "parent", throughSeq: 199 }]);
    expect(capsule.handoff.omitted).toEqual({ assets: true });
    expect(snapshot.assets).toEqual([]);
    expect(() => contextCapsuleOf({ ...snapshot, consumer: { ...snapshot.source, attempt: "1" } })).toThrow();
    expect(() =>
      contextCapsuleOf({
        ...snapshot,
        notepad: { text: "x".repeat(UNIT_CONTEXT_MAX_BYTES), updatedAt: 0, hash: "a".repeat(64) },
      }),
    ).toThrow();
    expect(isUnitContext({ version: 1, handoff: null })).toBe(false);
    const note = await snapshotNotepad({ text: "original", updatedAt: 1 });
    expect(contextCapsuleOf({ ...snapshot, notepad: note }).handoff.notepad).toEqual(note);
  });
});
