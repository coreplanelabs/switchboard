import { describe, expect, it, vi } from "vitest";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { performRecoverPublication, type RecoverPublicationDeps } from "./recoverPublicationEffect.js";

const HEAD = "a".repeat(40);
const instance: CoordinatorInstance = {
  id: "ship_recover_publication",
  kind: "ship",
  userId: "slack:UALICE",
  channelId: "slack:C1",
  threadKey: "slack:C1:1",
  repo: "acme/api",
  branch: "fix/unit",
  base: "main",
  merge: "person",
  createdAt: 1,
};
const unit: CoordinatorUnit = {
  instanceId: instance.id,
  unit: "ONE",
  slug: "one",
  branch: instance.branch,
  dependsOn: [],
  rounds: [],
  threadKey: instance.threadKey,
};
const input = {
  instance,
  unit,
  execution: { workflowId: instance.id },
  effectId: "ONE/0/pr-check",
  ordinal: 1,
  runId: "11111111-1111-4111-8111-111111111111",
  headSha: HEAD,
};
async function harness() {
  const ledger = new InMemoryRunLedger();
  const instances = new InMemoryCoordinatorInstanceStore(ledger);
  await instances.put(instance);
  await instances.putUnits([unit]);
  let renders = 0,
    creates = 0;
  const deps = {
    instances,
    ledger,
    head: async () => HEAD,
    render: async () => {
      renders++;
      return { title: "fix(core): recover original work", body: "Original body" };
    },
    create: async () => {
      creates++;
      return {
        state: "accepted" as const,
        headSha: HEAD,
        pr: { number: 7, htmlUrl: "https://github.com/acme/api/pull/7", created: true },
      };
    },
    rewrite: async () => ({ kind: "clean" as const }),
  };
  return { deps, count: () => ({ renders, creates }) };
}
describe("dead child publication fence", () => {
  it("settles a definite create refusal and replays its consumed ordinal without another POST", async () => {
    const h = await harness();
    let creates = 0;
    const deps = {
      ...h.deps,
      create: async () => {
        creates++;
        return { state: "refused" as const, status: 422 };
      },
    };
    const expected = { ok: true, refused: true, effectOrdinal: 1 };
    expect(await performRecoverPublication(input, deps)).toEqual(expected);
    const row = (await h.deps.instances.listUnits(instance.id))[0]!;
    expect(row.currentEffect?.phase).toBe("settled");
    expect(row.currentEffect?.calls).toEqual([
      { operation: "pull_create", state: "refused", cause: "external_refused" },
    ]);
    expect(await performRecoverPublication({ ...input, unit: row }, deps)).toEqual(expected);
    expect(creates).toBe(1);
  });
  it("cancels the unstarted create after a definite ref refusal and settles without publication", async () => {
    const h = await harness();
    let moves = 0;
    const deps = {
      ...h.deps,
      rewrite: async (publication: import("../../execution/identityRewrite.js").IdentityRefPublication) => {
        const claim = await publication.begin({
          repo: instance.repo,
          update: { ref: `refs/heads/${unit.branch}`, old: HEAD, next: "b".repeat(40) },
        });
        moves++;
        expect(await claim!.finish("not_forwarded")).toBe(true);
        return { kind: "unreadable" as const, reason: "native ref write definitively refused" };
      },
    };
    expect(await performRecoverPublication(input, deps)).toEqual({ ok: true, refused: true, effectOrdinal: 1 });
    const row = (await h.deps.instances.listUnits(instance.id))[0]!;
    expect(row.currentEffect?.phase).toBe("settled");
    expect(row.currentEffect?.calls).toEqual([
      { operation: "rebase_push", state: "refused", cause: "external_refused" },
      { operation: "pull_create", state: "refused", cause: "not_started" },
    ]);
    expect(await performRecoverPublication({ ...input, unit: row }, deps)).toEqual({
      ok: true,
      refused: true,
      effectOrdinal: 1,
    });
    expect(moves).toBe(1);
    expect(h.count().creates).toBe(0);
  });

  it("retains accepted creates with missing or different native head as uncertain without PR credit or replay", async () => {
    for (const headSha of [undefined, "b".repeat(40)]) {
      const h = await harness();
      let calls = 0;
      const deps = {
        ...h.deps,
        create: (async () => {
          calls++;
          return {
            state: "accepted",
            pr: { number: 7, htmlUrl: "https://github.com/acme/api/pull/7", created: true },
            ...(headSha === undefined ? {} : { headSha }),
          };
        }) as unknown as RecoverPublicationDeps["create"],
      };
      expect(await performRecoverPublication(input, deps)).toEqual({ ok: false, reason: "uncertain" });
      const row = (await h.deps.instances.listUnits(instance.id))[0]!;
      expect(row.pr).toBeUndefined();
      expect(row.currentEffect?.calls).toEqual([{ operation: "pull_create", state: "uncertain" }]);
      expect(await performRecoverPublication({ ...input, unit: row }, deps)).toEqual({
        ok: false,
        reason: "uncertain",
      });
      expect(calls).toBe(1);
    }
  });
  it("keeps an unanswered create owned across restart and never rerenders or duplicates it", async () => {
    const h = await harness();
    const lost = {
      ...h.deps,
      create: async () => {
        await h.deps.create();
        throw new Error("lost response");
      },
    };
    expect(await performRecoverPublication(input, lost)).toMatchObject({ ok: false, reason: "uncertain" });
    const row = (await h.deps.instances.listUnits(instance.id))[0]!;
    expect(row.currentEffect?.calls[0]?.state).toBe("uncertain");
    expect(await performRecoverPublication({ ...input, unit: row }, h.deps)).toMatchObject({
      ok: false,
      reason: "uncertain",
    });
    expect(h.count()).toEqual({ renders: 1, creates: 1 });
  });
  it("requires exact original execution and a matching ref before any publication", async () => {
    const h = await harness();
    expect(
      await performRecoverPublication({ ...input, execution: { workflowId: "ship_other" } }, h.deps),
    ).toMatchObject({ ok: false, reason: "execution" });
    expect(await performRecoverPublication(input, { ...h.deps, head: async () => "b".repeat(40) })).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(h.count().creates).toBe(0);
  });
  it("replays an acknowledged native creation from its durable receipt without writes", async () => {
    const h = await harness();
    const first = await performRecoverPublication(input, h.deps);
    expect(first).toMatchObject({ ok: true, pr: { number: 7 }, effectOrdinal: 1 });
    const row = (await h.deps.instances.listUnits(instance.id))[0]!;
    expect(await performRecoverPublication({ ...input, unit: row }, h.deps)).toEqual(first);
    expect(h.count()).toEqual({ renders: 1, creates: 1 });
  });
  it("fences the exact identity ref before moving it and only then creates at the native accepted new head", async () => {
    const h = await harness();
    const next = "b".repeat(40);
    let head = HEAD;
    const deps = {
      ...h.deps,
      head: async () => head,
      rewrite: async (publication: import("../../execution/identityRewrite.js").IdentityRefPublication) => {
        const claim = await publication.begin({
          repo: instance.repo,
          update: { ref: `refs/heads/${unit.branch}`, old: HEAD, next },
        });
        expect(claim).toBeDefined();
        const row = (await h.deps.instances.listUnits(instance.id))[0]!;
        expect(row.currentEffect?.calls[0]).toMatchObject({ operation: "rebase_push", state: "pending" });
        head = next;
        expect(await claim!.finish("accepted")).toBe(true);
        return { kind: "rewritten" as const, tip: next, count: 1, replaced: [] };
      },
      create: async (target: import("../../execution/githubPulls.js").PullRequestTarget & { headSha: string }) => {
        expect(target.headSha).toBe(next);
        return { ...(await h.deps.create()), headSha: target.headSha };
      },
    };
    expect(await performRecoverPublication(input, deps)).toMatchObject({ ok: true, pr: { number: 7 } });
    const row = (await h.deps.instances.listUnits(instance.id))[0]!;
    expect(row.currentEffect?.calls).toMatchObject([
      { operation: "rebase_push", state: "accepted", commitSha: next },
      { operation: "pull_create", state: "accepted", commitSha: next },
    ]);
    expect(await performRecoverPublication({ ...input, unit: row }, deps)).toMatchObject({ ok: true });
    expect(h.count()).toEqual({ renders: 1, creates: 1 });
  });
  it("retains uncertain identity ref admission and never creates or repeats the move after restart", async () => {
    const h = await harness();
    let moves = 0;
    const deps = {
      ...h.deps,
      rewrite: async (publication: import("../../execution/identityRewrite.js").IdentityRefPublication) => {
        const claim = await publication.begin({
          repo: instance.repo,
          update: { ref: `refs/heads/${unit.branch}`, old: HEAD, next: "b".repeat(40) },
        });
        moves++;
        await claim!.finish("unknown");
        return { kind: "unreadable" as const, reason: "native response unknown" };
      },
    };
    expect(await performRecoverPublication(input, deps)).toMatchObject({ ok: false, reason: "uncertain" });
    const row = (await h.deps.instances.listUnits(instance.id))[0]!;
    expect(await performRecoverPublication({ ...input, unit: row }, deps)).toMatchObject({
      ok: false,
      reason: "uncertain",
    });
    expect(moves).toBe(1);
    expect(h.count().creates).toBe(0);
  });

  it("replays a committed native receipt after its completion acknowledgment is lost", async () => {
    const h = await harness();
    const move = h.deps.instances.transitionUnitEffect.bind(h.deps.instances);
    let lost = true;
    vi.spyOn(h.deps.instances, "transitionUnitEffect").mockImplementation(async (change) => {
      const result = await move(change);
      if (change.kind === "complete" && lost) {
        lost = false;
        throw new Error("ACK lost");
      }
      return result;
    });
    expect(await performRecoverPublication(input, h.deps)).toMatchObject({ ok: false, reason: "unavailable" });
    const row = (await h.deps.instances.listUnits(instance.id))[0]!;
    expect(row.currentEffect?.calls[0]?.state).toBe("accepted");
    expect(await performRecoverPublication({ ...input, unit: row }, h.deps)).toMatchObject({
      ok: true,
      pr: { number: 7 },
    });
    expect(h.count()).toEqual({ renders: 1, creates: 1 });
  });
  it("uses the first frozen payload after a crash before the external call", async () => {
    const h = await harness();
    const move = h.deps.instances.transitionUnitEffect.bind(h.deps.instances);
    let refused = true;
    vi.spyOn(h.deps.instances, "transitionUnitEffect").mockImplementation(async (change) =>
      change.kind === "begin" && refused ? ((refused = false), { ok: false, reason: "unavailable" }) : move(change),
    );
    expect(await performRecoverPublication(input, h.deps)).toMatchObject({ ok: false, reason: "unavailable" });
    const row = (await h.deps.instances.listUnits(instance.id))[0]!;
    const render = vi.fn(async () => ({ title: "changed", body: "changed" }));
    expect(
      await performRecoverPublication(
        { ...input, unit: row },
        {
          ...h.deps,
          render,
          create: async (target) => {
            expect(target.body).toBe("Original body");
            return h.deps.create();
          },
        },
      ),
    ).toMatchObject({ ok: true });
    expect(render).not.toHaveBeenCalled();
    expect(h.count()).toEqual({ renders: 1, creates: 1 });
  });
});
