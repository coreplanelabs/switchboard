import { describe, expect, it } from "vitest";
import {
  ProductionRunEffects,
  RecordingRunEffects,
  type EffectEnvelope,
  type PushFacts,
  type PushGateReceipt,
  type RunEffectsDeps,
} from "./runEffects.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const TREE_A = "1".repeat(40);
const TREE_B = "2".repeat(40);
const TREE_C = "3".repeat(40);

const envelope = (over: Partial<EffectEnvelope["command"]> = {}): EffectEnvelope => ({
  effectId: "effect-push-1",
  command: {
    kind: "push",
    repository: "acme/api",
    branch: "feat/exact-tree",
    expectedHead: A,
    base: "main",
    gateSet: "changed-set",
    ...over,
  },
});

interface WorldOptions {
  authorized?: boolean;
  initial?: Partial<PushFacts>;
  rebased?: Partial<PushFacts>;
  rechecked?: Partial<PushFacts>;
  gates?: PushGateReceipt[];
  publishError?: Error;
  reconciliationError?: Error;
  recordError?: Error;
  recordFailures?: number;
  reconciledHead?: string;
}

function world(opts: WorldOptions = {}) {
  const calls: string[] = [];
  const recorded: unknown[] = [];
  const audited: unknown[] = [];
  const persisted: EffectEnvelope[] = [];
  const envelopes = new Map<string, EffectEnvelope>();
  const receipts = new Map<string, unknown>();
  const preparedIntents = new Map<string, unknown>();
  let recordFailures = opts.recordFailures ?? (opts.recordError ? Number.POSITIVE_INFINITY : 0);
  let reconciledHead = opts.reconciledHead;
  const initial: PushFacts = {
    repository: "acme/api",
    endpoint: "https://github.com/acme/api.git",
    branch: "feat/exact-tree",
    head: A,
    tree: TREE_A,
    clean: true,
    remoteHead: B,
    ...opts.initial,
  };
  const rebased: PushFacts = { ...initial, head: C, tree: TREE_B, ...opts.rebased };
  const rechecked: PushFacts = { ...rebased, ...opts.rechecked };
  const gates = opts.gates ?? [
    { name: "tests", exitCode: 0, tree: rebased.tree, clean: true },
    { name: "format", exitCode: 0, tree: rebased.tree, clean: true },
  ];
  let resolves = 0;
  const deps: RunEffectsDeps = {
    persistEnvelope: async (value) => {
      calls.push("persist");
      persisted.push(value);
      const prior = envelopes.get(value.effectId);
      if (prior) return prior;
      envelopes.set(value.effectId, value);
      return value;
    },
    priorResult: async (effectId) => receipts.get(effectId),
    persistPrepared: async (intent) => {
      calls.push("prepare");
      const prior = preparedIntents.get(intent.effectId);
      if (prior) return prior as typeof intent;
      preparedIntents.set(intent.effectId, intent);
      return intent;
    },
    priorPrepared: async (effectId) => preparedIntents.get(effectId),
    resolvePush: async () => {
      calls.push("resolve");
      resolves++;
      return resolves === 1 ? initial : rechecked;
    },
    authorizePush: async () => {
      calls.push("authorize");
      return opts.authorized ?? true;
    },
    rebasePush: async () => {
      calls.push("rebase");
      return rebased;
    },
    runPushGates: async () => {
      calls.push("gates");
      return gates;
    },
    publishPush: async (request) => {
      calls.push("publish");
      if (opts.publishError) throw opts.publishError;
      reconciledHead = request.source;
      return { previous: request.lease, published: request.source };
    },
    reconcilePush: async () => {
      calls.push("reconcile");
      if (opts.reconciliationError) throw opts.reconciliationError;
      return reconciledHead;
    },
    recordResult: async (result) => {
      calls.push("record");
      if (recordFailures > 0) {
        recordFailures--;
        throw opts.recordError ?? new Error("ledger unavailable");
      }
      recorded.push(result);
      receipts.set(result.effectId, result);
    },
    auditResult: async (result) => {
      calls.push("audit");
      audited.push(result);
    },
    occurredAt: () => 1_700_000_000_000,
    actor: "chat:user",
  };
  return { deps, calls, recorded, audited, persisted, envelopes, receipts, preparedIntents };
}

describe.each([
  ["production", (deps: RunEffectsDeps) => new ProductionRunEffects(deps), true],
  ["recording", (deps: RunEffectsDeps) => new RecordingRunEffects(deps), false],
] as const)("RunEffects conformance — %s", (_name, make, publishes) => {
  it("persists the caller-minted envelope before resolve", async () => {
    const w = world();
    await make(w.deps).execute(envelope());
    expect(w.calls.slice(0, 2)).toEqual(["persist", "resolve"]);
    expect(w.persisted).toEqual([envelope()]);
  });

  it("resolves, authorizes, fences, rebases, gates and records in lifecycle order", async () => {
    const w = world();
    const result = await make(w.deps).execute(envelope());
    expect(w.calls).toEqual([
      "persist",
      "resolve",
      "authorize",
      "rebase",
      "gates",
      "resolve",
      ...(publishes ? ["prepare", "publish"] : []),
      "record",
    ]);
    expect(result).toMatchObject({ effectId: "effect-push-1", kind: "push" });
    expect(w.recorded).toHaveLength(1);
  });

  it("returns the recorded result on retry with the same effectId without resolving or publishing again", async () => {
    const w = world();
    const effects = make(w.deps);
    const first = await effects.execute(envelope());
    w.calls.length = 0;
    const retried = await effects.execute(envelope());
    expect(retried).toEqual(first);
    expect(w.calls).toEqual(["persist"]);
  });

  it("immutably binds an effectId to its first complete command without replacing its standing result", async () => {
    const w = world();
    const effects = make(w.deps);
    const first = await effects.execute(envelope());
    w.calls.length = 0;
    const reused = await effects.execute(envelope({ branch: "feat/other", expectedHead: B }));
    expect(reused).toMatchObject({ outcome: "refused", reason: "effect_id_reused" });
    expect(w.envelopes.get("effect-push-1")).toEqual(envelope());
    expect(w.receipts.get("effect-push-1")).toEqual(first);
    expect(w.audited).toContainEqual(reused);
    expect(w.calls).toEqual(["persist", "audit"]);
  });

  it("refuses an unauthorized push before rebase, gates or transport", async () => {
    const w = world({ authorized: false });
    const result = await make(w.deps).execute(envelope());
    expect(result).toMatchObject({ outcome: "refused", reason: "not_authorized" });
    expect(w.calls).toEqual(["persist", "resolve", "authorize", "record"]);
  });
});

describe("ProductionRunEffects — push owns one exact gated tree", () => {
  it("lease-publishes the rebased source to the resolved run-owned destination and records exact-tree gate receipts", async () => {
    const w = world();
    const result = await new ProductionRunEffects(w.deps).execute(envelope());
    expect(result).toMatchObject({
      outcome: "succeeded",
      repository: "acme/api",
      destination: "refs/heads/feat/exact-tree",
      before: B,
      after: C,
      tree: TREE_B,
      by: "runner",
      gates: [
        { name: "tests", exitCode: 0, tree: TREE_B, clean: true },
        { name: "format", exitCode: 0, tree: TREE_B, clean: true },
      ],
    });
  });

  it("refuses a source, endpoint or destination that does not resolve to the admitted command", async () => {
    for (const [field, value, reason] of [
      ["repository", "other/repo", "wrong_repository"],
      ["branch", "main", "wrong_ref"],
      ["endpoint", "https://example.com/other.git", "wrong_repository"],
    ] as const) {
      const w = world({ initial: { [field]: value } });
      const result = await new ProductionRunEffects(w.deps).execute(envelope());
      expect(result).toMatchObject({ outcome: "refused", reason });
      expect(w.calls).not.toContain("publish");
    }
  });

  it("invalidates earlier-tree gate evidence when the tree or clean state changes after gates", async () => {
    for (const rechecked of [{ tree: TREE_C }, { clean: false }] as const) {
      const w = world({ rechecked });
      const result = await new ProductionRunEffects(w.deps).execute(envelope());
      expect(result).toMatchObject({
        outcome: "refused",
        reason: rechecked.clean === false ? "dirty_tree" : "gates_missing",
      });
      expect(w.calls).not.toContain("publish");
    }
  });

  it("refuses a failed canonical gate and never publishes", async () => {
    const w = world({ gates: [{ name: "format", exitCode: 1, tree: TREE_B, clean: true }] });
    const result = await new ProductionRunEffects(w.deps).execute(envelope());
    expect(result).toMatchObject({ outcome: "refused", reason: "gate_failed" });
    expect(w.calls).not.toContain("publish");
  });

  it("reconciles the destination to the intended sha after an ambiguous transport failure", async () => {
    const w = world({ publishError: new Error("response lost"), reconciledHead: C });
    const result = await new ProductionRunEffects(w.deps).execute(envelope());
    expect(result).toMatchObject({ outcome: "succeeded", before: B, after: C, by: "runner" });
    expect(w.calls.slice(-3)).toEqual(["publish", "reconcile", "record"]);

    w.calls.length = 0;
    expect(await new ProductionRunEffects(w.deps).execute(envelope())).toEqual(result);
    expect(w.calls).toEqual(["persist"]);
  });

  it("records transport_refused only after reconciliation does not find the intended sha", async () => {
    const w = world({ publishError: new Error("response lost"), reconciledHead: B });
    const result = await new ProductionRunEffects(w.deps).execute(envelope());
    expect(result).toMatchObject({ outcome: "refused", reason: "transport_refused" });
    expect(w.calls.slice(-3)).toEqual(["publish", "reconcile", "record"]);
  });

  it("leaves an effect retryable when reconciliation is unavailable", async () => {
    const w = world({
      publishError: new Error("response lost"),
      reconciliationError: new Error("ls-remote unavailable"),
    });
    const result = await new ProductionRunEffects(w.deps).execute(envelope());
    expect(result).toMatchObject({ outcome: "retryable", reason: "reconciliation_unavailable" });
    expect(w.calls.slice(-2)).toEqual(["publish", "reconcile"]);
    expect(w.calls).not.toContain("record");
    expect(w.receipts.has("effect-push-1")).toBe(false);
  });

  it("propagates receipt persistence failure after a successful publication without reconciling or recording a refusal", async () => {
    const w = world({ recordError: new Error("ledger unavailable") });
    await expect(new ProductionRunEffects(w.deps).execute(envelope())).rejects.toThrow("ledger unavailable");
    expect(w.calls.slice(-2)).toEqual(["publish", "record"]);
    expect(w.calls).not.toContain("reconcile");
    expect(w.recorded).toEqual([]);
    expect(w.receipts.has("effect-push-1")).toBe(false);
    expect(w.preparedIntents.has("effect-push-1")).toBe(true);
  });

  it("recovers a receipt on retry after publication succeeded but its first durable write failed", async () => {
    const w = world({ recordFailures: 1 });
    const effects = new ProductionRunEffects(w.deps);

    await expect(effects.execute(envelope())).rejects.toThrow("ledger unavailable");
    expect(w.calls.filter((call) => call === "publish")).toHaveLength(1);
    expect(w.receipts.has("effect-push-1")).toBe(false);

    w.calls.length = 0;
    const recovered = await effects.execute(envelope());
    expect(recovered).toMatchObject({ outcome: "succeeded", before: B, after: C, tree: TREE_B, by: "runner" });
    expect(w.calls).toEqual(["persist", "reconcile", "record"]);
    expect(w.calls).not.toContain("resolve");
    expect(w.calls).not.toContain("publish");
    expect(w.receipts.get("effect-push-1")).toEqual(recovered);
  });

  it("does not mistake a shadow observation for publication after cutover", async () => {
    const w = world();
    w.receipts.set("effect-push-1", {
      effectId: "effect-push-1",
      kind: "push",
      outcome: "succeeded",
      shadow: true,
    });
    const result = await new ProductionRunEffects(w.deps).execute(envelope());
    expect(result).toMatchObject({ outcome: "succeeded", after: C });
    expect(result).not.toHaveProperty("shadow");
    expect(w.calls).toContain("publish");
  });
});

describe("RecordingRunEffects — shadow observes without publication", () => {
  it("records the decision but never calls the transport", async () => {
    const w = world();
    const result = await new RecordingRunEffects(w.deps).execute(envelope());
    expect(result).toMatchObject({ outcome: "succeeded", shadow: true, by: "runner" });
    expect(w.calls).not.toContain("publish");
  });
});
