import { describe, expect, it, vi } from "vitest";
import {
  createMergeReadyBook,
  createMergeWatch,
  MERGE_WATCH_DEFAULTS,
  resolveMergeWatch,
  spendCapLine,
  type MergeReadyEntry,
  type MergeWatchDeps,
  type MergeWatchSettings,
  type WatchedPullFacts,
} from "./mergeWatch.js";
import type { SweepReport } from "./pullSweep.js";

// Watch until merge, as a setting (record 0071, mechanism three;
// docs/reference/specs/agent-ship.md item 21, routing-and-config.md item 32).

const entry = (over: Partial<MergeReadyEntry> = {}): MergeReadyEntry => ({
  repo: "acme/api",
  number: 7,
  base: "main",
  headSha: "a".repeat(40),
  instanceId: "inst-1",
  unit: "U12",
  threadKey: "slack:C1:1.0",
  requester: "slack:U12",
  ...over,
});

const report = (repo: string, number: number): SweepReport => ({
  repo,
  results: [{ repo, number, outcome: "carried", line: `#${number} rebased` }],
});

/** A deferred: the test holds a resolver round open to watch the cap. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function harness(over: Partial<MergeWatchDeps> = {}, settings: Partial<MergeWatchSettings> = {}) {
  const book = createMergeReadyBook();
  const resolved: MergeReadyEntry[] = [];
  const cards: string[] = [];
  const merged: Array<{ entry: MergeReadyEntry; sha: string; mergedAt: string }> = [];
  const deps: MergeWatchDeps = {
    settings: () => ({ ...MERGE_WATCH_DEFAULTS, watch: true, ...settings }),
    book,
    facts: async () => ({ state: "open", mergeableState: "dirty" }) as WatchedPullFacts,
    resolve: async (e) => {
      resolved.push(e);
      return report(e.repo, e.number);
    },
    spendOf: async () => 0,
    card: async (_e, line) => {
      cards.push(line);
    },
    merged: async (e, facts) => {
      merged.push({ entry: e, ...facts });
    },
    ...over,
  };
  return { watch: createMergeWatch(deps), book, resolved, cards, merged };
}

describe("the watch setting's scopes (record 0071: off by default, org on, repo override over either)", () => {
  it("is off by default, with one rebase in flight and the sweep round's spend cap", () => {
    expect(resolveMergeWatch(undefined, undefined)).toEqual(MERGE_WATCH_DEFAULTS);
    expect(MERGE_WATCH_DEFAULTS.watch).toBe(false);
  });

  it("the org turns it on for every repository that says nothing", () => {
    expect(resolveMergeWatch({ watch: true }, undefined).watch).toBe(true);
    expect(resolveMergeWatch({ watch: true }, {}).watch).toBe(true);
  });

  it("a repository's word wins over either org word: on over off, off over on", () => {
    expect(resolveMergeWatch({ watch: false }, { watch: true }).watch).toBe(true);
    expect(resolveMergeWatch(undefined, { watch: true }).watch).toBe(true);
    expect(resolveMergeWatch({ watch: true }, { watch: false }).watch).toBe(false);
    expect(resolveMergeWatch({}, { watch: false }).watch).toBe(false);
  });

  it("the caps resolve per key: a repository overrides one cap and inherits the other", () => {
    const resolved = resolveMergeWatch({ watch: true, rebaseInFlight: 2, spendLimitUsd: 10 }, { rebaseInFlight: 1 });
    expect(resolved).toEqual({ watch: true, rebaseInFlight: 1, spendLimitUsd: 10 });
  });
});

describe("a DIRTY push-to-base wakes the resolver under the caps (record 0071, mechanism three)", () => {
  it("one DIRTY pull request buys exactly one resolver round; a second queues behind the per-repository cap and runs when the slot frees", async () => {
    const first = deferred();
    const order: number[] = [];
    const { watch, book } = harness({
      resolve: async (e) => {
        order.push(e.number);
        if (e.number === 7) await first.promise;
        return report(e.repo, e.number);
      },
    });
    book.note(entry({ number: 7 }));
    book.note(entry({ number: 8 }));
    const results = await watch.pushToBase("acme/api", "main");
    expect(results).toEqual([
      { repo: "acme/api", number: 7, outcome: "resolver" },
      { repo: "acme/api", number: 8, outcome: "queued" },
    ]);
    await tick();
    // The first round holds the repository's one slot; the second waits.
    expect(order).toEqual([7]);
    first.resolve();
    await tick();
    await tick();
    expect(order).toEqual([7, 8]);
  });

  it("a queued entry's throw is logged under its own pull request, not the round that queued it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = deferred();
      const { watch, book } = harness({
        resolve: async (e) => {
          if (e.number === 7) {
            await first.promise;
            return report(e.repo, e.number);
          }
          throw new Error("clone refused");
        },
      });
      book.note(entry({ number: 7 }));
      book.note(entry({ number: 8 }));
      await watch.pushToBase("acme/api", "main");
      first.resolve();
      await tick();
      await tick();
      const lines = errors.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain("[merge-watch] resolver failed for acme/api#8: clone refused");
      expect(lines.join("\n")).not.toContain("#7");
    } finally {
      errors.mockRestore();
    }
  });

  it("a stale-but-clean pull request is never rebased: it stands as it is", async () => {
    const { watch, book, resolved } = harness({
      facts: async () => ({ state: "open", mergeableState: "behind" }),
    });
    book.note(entry());
    expect(await watch.pushToBase("acme/api", "main")).toEqual([{ repo: "acme/api", number: 7, outcome: "stood" }]);
    expect(resolved).toEqual([]);
  });

  it("a still-recomputing mergeable_state stands too — nothing retries on a clock", async () => {
    const { watch, book, resolved } = harness({ facts: async () => ({ state: "open", mergeableState: "unknown" }) });
    book.note(entry());
    expect((await watch.pushToBase("acme/api", "main"))[0]!.outcome).toBe("stood");
    expect(resolved).toEqual([]);
  });

  it("with the watch off for the repository, no round is bought", async () => {
    const { watch, book, resolved } = harness({}, { watch: false });
    book.note(entry());
    expect((await watch.pushToBase("acme/api", "main"))[0]!.outcome).toBe("off");
    expect(resolved).toEqual([]);
  });

  it("a push to another base, or another repository, wakes nothing", async () => {
    const { watch, book, resolved } = harness();
    book.note(entry({ base: "main" }));
    expect(await watch.pushToBase("acme/api", "release")).toEqual([]);
    expect(await watch.pushToBase("acme/web", "main")).toEqual([]);
    expect(resolved).toEqual([]);
  });
});

describe("the spend cap: the DIRTY stands and the card names the sweep (record 0071)", () => {
  it("a pull request at its spend limit buys no round; its card names `pulls rebase`", async () => {
    const { watch, book, resolved, cards } = harness({ spendOf: async () => 5 }, { spendLimitUsd: 5 });
    book.note(entry());
    expect((await watch.pushToBase("acme/api", "main"))[0]!.outcome).toBe("spend-capped");
    expect(resolved).toEqual([]);
    expect(cards).toEqual([spendCapLine({ repo: "acme/api", number: 7 }, 5)]);
    expect(cards[0]).toContain("pulls rebase acme/api#7");
  });
});

describe("a merged fact, whoever merged, ends the unit `merged` by other (record 0071)", () => {
  it("hands the merge's facts to the waiting unit and drops the book's entry", async () => {
    const { watch, book, resolved, merged } = harness({
      facts: async () => ({ state: "merged", sha: "b".repeat(40), mergedAt: "2026-09-20T00:00:00Z" }),
    });
    book.note(entry());
    expect((await watch.pushToBase("acme/api", "main"))[0]!.outcome).toBe("merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ sha: "b".repeat(40), mergedAt: "2026-09-20T00:00:00Z" });
    expect(merged[0]!.entry.instanceId).toBe("inst-1");
    expect(resolved).toEqual([]);
    // Dropped: the next push finds nothing to read.
    expect(await watch.pushToBase("acme/api", "main")).toEqual([]);
  });

  it("a closed-unmerged pull request is dropped without a word", async () => {
    const { watch, book, merged } = harness({ facts: async () => ({ state: "closed" }) });
    book.note(entry());
    expect((await watch.pushToBase("acme/api", "main"))[0]!.outcome).toBe("dropped");
    expect(merged).toEqual([]);
    expect(await watch.pushToBase("acme/api", "main")).toEqual([]);
  });
});

describe("the merge-ready book", () => {
  it("notes one entry per pull request (a re-registration replaces), drops by number, lists by base", () => {
    const book = createMergeReadyBook();
    book.note(entry({ number: 7, headSha: "a".repeat(40) }));
    book.note(entry({ number: 7, headSha: "c".repeat(40) }));
    book.note(entry({ number: 8 }));
    const onMain = book.onBase("acme/api", "main");
    expect(onMain).toHaveLength(2);
    expect(onMain.find((e) => e.number === 7)?.headSha).toBe("c".repeat(40));
    book.drop("acme/api", 7);
    expect(book.onBase("acme/api", "main").map((e) => e.number)).toEqual([8]);
  });
});
