import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backupIdsOf, RETIRED_SNAPSHOT_KEY, rotateSnapshots, SNAPSHOT_GENERATIONS } from "./snapshotRetention.js";

// A resident keeps two snapshot generations (docs/reference/specs/resident-repos.md
// item 7): the refresh that writes a new pair retires the one it replaced and
// deletes the objects of the generation retired before it. A seeded sandbox
// that read the checkout handle from `/status` seconds before a rotation
// therefore still finds its objects for at least one more cycle; deleting the
// replaced pair at once would 404 exactly during a release train, the burst
// the seeded tier exists for.

const gen = (n: number) => ({ mirror: { id: `m${n}` }, checkout: { id: `c${n}` }, sha: `sha${n}` });

describe("rotateSnapshots", () => {
  it("keeps two generations: the replaced pair is retired, the pair retired before it is deleted", () => {
    expect(SNAPSHOT_GENERATIONS).toBe(2);
    const rotation = rotateSnapshots({ replaced: gen(2), retired: gen(1) });
    expect(rotation.retired).toEqual(gen(2));
    expect(rotation.deleteIds).toEqual(["m1", "c1"]);
  });

  it("the first rotation retires without deleting: nothing was retired before", () => {
    expect(rotateSnapshots({ replaced: gen(1), retired: undefined })).toEqual({ retired: gen(1), deleteIds: [] });
  });

  it("a rotation that replaces the pair already retired deletes nothing: the objects are the ones kept", () => {
    expect(rotateSnapshots({ replaced: gen(1), retired: gen(1) })).toEqual({ retired: gen(1), deleteIds: [] });
  });

  it("a rotation with nothing replaced (the first snapshot ever) leaves the retired generation alone", () => {
    expect(rotateSnapshots({ replaced: undefined, retired: gen(1) })).toEqual({ retired: gen(1), deleteIds: [] });
    expect(rotateSnapshots({ replaced: undefined, retired: undefined })).toEqual({
      retired: undefined,
      deleteIds: [],
    });
  });
});

describe("backupIdsOf", () => {
  it("names every recorded generation's objects once, current first, skipping what is not recorded", () => {
    expect(backupIdsOf([gen(2), gen(1)])).toEqual(["m2", "c2", "m1", "c1"]);
    expect(backupIdsOf([gen(2), undefined])).toEqual(["m2", "c2"]);
    expect(backupIdsOf([undefined, undefined])).toEqual([]);
    expect(backupIdsOf([gen(1), gen(1)])).toEqual(["m1", "c1"]);
  });
});

// The resident Worker cannot run under vitest; its use of the decision is
// held statically, the way the disk budget's wiring is.
describe("the resident Worker's wiring", () => {
  const source = readFileSync(new URL("../../deploy/cloudflare-resident/worker.ts", import.meta.url), "utf8");

  it("the refresh's snapshot phase rotates through the decision instead of deleting the replaced pair", () => {
    expect(source).toMatch(/rotateSnapshots\(\{/);
    expect(source).toMatch(/RETIRED_SNAPSHOT_KEY/);
    expect(source).not.toMatch(/deleteBackupObjects\(\[previous\.mirror\.id, previous\.checkout\.id\]\)/);
  });

  it("the offboard plan, the rebuild plan and both teardowns name every recorded generation", () => {
    expect(source).toMatch(/backupIdsOf\(/);
    const uses = source.match(/recordedBackupIds\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(4);
    // The only pair deleted by its own handles is a superseded snapshot's own fresh objects.
    const direct = source.match(/deleteBackupObjects\(\[snap\.mirror\.id, snap\.checkout\.id\]\)/g) ?? [];
    expect(direct.length).toBeLessThanOrEqual(2);
  });

  it("a fresh onboard forgets the retired generation with the current one", () => {
    expect(source).toMatch(/storage\.delete\(\[FACTS_KEY, SNAPSHOT_KEY, RETIRED_SNAPSHOT_KEY\]\)/);
  });

  it("the retired key is the module's constant, spelled once", () => {
    expect(RETIRED_SNAPSHOT_KEY).toBe("resident:snapshot:retired");
    expect(source).not.toMatch(/"resident:snapshot:retired"/);
  });
});
