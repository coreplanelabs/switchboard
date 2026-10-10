import { booleanAudienceVerifier } from "../testing/audienceVerifier.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../config.js";
import { getAgent } from "../../agents/registry.js";
import { originalColdAllocation } from "../runLedger/workspaceDurability.js";
import { declaredProfile } from "../../config/profile.js";
import { InMemoryGithubApi } from "../../execution/githubApi.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import { RunRegistry } from "../runRegistry.js";
import type { RunEvent } from "../runEvents.js";
import {
  NullLedgerRun,
  NullLedgerWriteThrough,
  type OpenOutcome,
  type OpenRunRequest,
} from "../runLedger/writeThrough.js";
import { NullRunHistoryWriter } from "../runHistoryWriter.js";
import { NullRunStore } from "../runStore.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { createLedgerWriteThrough } from "../runLedger/writeThrough.js";
import type { IncomingMessage } from "../types.js";
import { chatActorOf } from "../authz/actor.js";
import { InMemoryCoordinatorInstanceStore } from "../coordinator/instanceStore.js";
import type { PlaneService } from "../planeService.js";
import { InMemoryPrivateWorkerLog } from "../privateWorkerLog.js";
import type { ResumeContext } from "./admission.js";
import { resolveRun } from "./resolve.js";
import { carriedOperationTarget } from "./reattach.js";
import {
  claimRun,
  DEPLOY_RESTART_NOTICE,
  githubCapabilityFor,
  setShutdownNotice,
  shutdownNotice,
  type RunDeps,
} from "./run.js";

// Feature: docs/reference/specs/run-history.md item 35 (the claim), docs/reference/specs/
// github-tools.md (the per-run capability), docs/reference/specs/run-visibility.md
// (the shutdown notice) — the run stage's own contract around the loop. The
// loop itself is runLoop.test.ts; what a claimed run does end to end is proven
// through `dispatch()` in `src/core/dispatcher.test.ts`.

const NOW = 10_000;
const THREAD = "slack:CX:1.0";

const YAML = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
    coding: anthropic/coding-model
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
  "slack:UDEV": { repos: ["acme/api"] }
restrict:
  repos: ["acme/secret"]
`;

function configStore(): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-run-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, YAML);
  return new ConfigStore(path, join(dir, "overrides.json"));
}

/** A ledger row handle that remembers the events mirrored onto it. */
class RecordingRun extends NullLedgerRun {
  override tracked(): boolean {
    return true;
  }
  readonly events: Array<{ event: RunEvent; seq: number }> = [];
  override event(event: RunEvent, seq: number): void {
    this.events.push({ event, seq });
  }
}

/** A write-through that records the claims asked of it and answers with a recording handle. */
class RecordingLedger extends NullLedgerWriteThrough {
  readonly opened: OpenRunRequest[] = [];
  handle: RecordingRun | undefined;
  constructor() {
    super("gen-T", new NullRunStore());
  }
  override async open(req: OpenRunRequest): Promise<OpenOutcome> {
    this.opened.push(req);
    this.handle = new RecordingRun(req.runId, { put: async () => {}, abandoned: () => {} });
    return { kind: "tracked", run: this.handle };
  }
}

const msg = (text: string, user = "slack:UX"): IncomingMessage => ({
  channelId: "slack:CX",
  userId: user,
  threadKey: THREAD,
  text,
});

function setup() {
  const ledger = new RecordingLedger();
  const config = configStore();
  const deps: RunDeps = {
    config,
    runLedger: ledger,
    runHistoryWriter: new NullRunHistoryWriter(),
    runStore: new NullRunStore(),
    githubApi: new InMemoryGithubApi(),
  };
  const message = msg("agent:coding fix it");
  const { resolved } = resolveRun(
    { config },
    { msg: message, directives: { agent: "coding", text: "fix it" }, history: [] },
  );
  const agent = getAgent(resolved.agentName);
  const registry = new RunRegistry({ now: () => NOW, genId: () => "run-c", genToken: () => "tok" });
  const run = registry.create("coding · acme/api", {
    agent: "coding",
    channelId: "slack:CX",
    userId: "slack:UX",
    threadKey: THREAD,
    receivedAt: NOW,
  });
  const trace = startRequestRoot({ clock: () => NOW }, { channel: channelOf(message.channelId), receivedAt: NOW });
  const base = {
    msg: message,
    agent,
    profile: declaredProfile(agent),
    resolved,
    repoCtx: { repo: "acme/api", ref: "main" },
    channelVisibility: "unknown" as const,
    run,
    registry,
    selection: {
      executor: {} as never,
      resident: true,
      binding: { ref: "main", sha: "a".repeat(40), workspace: "/w" },
    },
    requestRow: { text: "fix it" },
    system: "the system prompt",
    mcpForRun: { tools: [], servers: [] },
    messages: [],
    card: { update: () => {}, done: async () => {}, handle: { channel: "CX", ts: "1.0" } },
    clock: () => NOW,
    root: trace.root,
  };
  return { deps, ledger, registry, run, agent, base };
}

describe("original admission identity at promotion", () => {
  async function original(kind: "v2" | "null") {
    const s = setup();
    const agent = getAgent("review"),
      profile = declaredProfile(agent),
      repoCtx = { repo: "acme/api", ref: "main", headSha: "a".repeat(40), pr: 42 };
    const registry = new RunRegistry({ now: () => NOW, genId: () => "run-c", genToken: () => "tok" });
    const run = registry.create(
      "review",
      {
        agent: "review",
        userId: s.base.msg.userId,
        channelId: s.base.msg.channelId,
        threadKey: THREAD,
      },
      { startedAt: NOW },
    );
    const store = new InMemoryRunLedger(() => NOW + 5000);
    const through = createLedgerWriteThrough({
      ledger: store,
      gen: "gen-T",
      now: () => NOW + 5000,
      warn: () => {},
      fallback: new NullRunStore(),
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    });
    const meta = {
      agent: "review",
      model: s.base.resolved.modelRef,
      userId: s.base.msg.userId,
      channelId: s.base.msg.channelId,
      threadKey: THREAD,
      ...repoCtx,
      readonly: true,
      profile,
    };
    const allocation =
      kind === "v2"
        ? originalColdAllocation({
            runId: run.id,
            registered: agent,
            identity: meta,
            target: repoCtx,
          })!
        : undefined;
    const outcome = await through.reserve({
      runId: run.id,
      threadKey: THREAD,
      startedAt: NOW,
      meta: { ...meta, ...(allocation ? { workspaceAllocation: allocation } : {}) },
    });
    if (outcome.kind !== "tracked") throw new Error("fixture reservation refused");
    const ctx = {
      ...s.base,
      agent,
      profile,
      repoCtx,
      registry,
      run,
      startedAt: NOW,
      clock: () => NOW + 5000,
      reserved: outcome.run,
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: s.base.msg.text }] }],
      resume: undefined,
      ledgerRun: undefined,
    };
    return { ...s, ctx, store, through, allocation };
  }
  it("keeps actual v2 and canonical-null receiver identity with matching or missing authenticated snapshots", async () => {
    for (const kind of ["v2", "null"] as const)
      for (const projection of ["matching", "missing"] as const) {
        const s = await original(kind);
        if (projection === "missing") vi.spyOn(s.ctx.registry, "snapshot").mockReturnValue(null);
        const claimed = await claimRun({ ...s.deps, runLedger: s.through }, s.ctx);
        expect(claimed?.tracked()).toBe(true);
        expect(s.store.live.get(s.ctx.run.id)).toMatchObject({ startedAt: NOW, phase: "live" });
        expect(claimed!.allocationAck).toMatchObject({ startedAt: NOW, allocation: s.allocation ?? null });
        expect(s.store.live.get(s.ctx.run.id)!.meta.workspaceAllocation).toEqual(s.allocation);
        await claimed?.close();
      }
  });
  it("holds conflicting start actor token or generation before promotion and preserves the original row", async () => {
    for (const mode of ["start", "actor", "token", "generation"] as const) {
      const s = await original("null"),
        saved = structuredClone(s.store.live.get(s.ctx.run.id)),
        claim = vi.spyOn(s.store, "claim");
      if (mode === "start") {
        const snapshot = s.ctx.registry.snapshot(s.ctx.run.id, s.ctx.run.token)!;
        vi.spyOn(s.ctx.registry, "snapshot").mockReturnValue({ ...snapshot, startedAt: NOW + 1 });
      }
      if (mode === "actor") s.ctx.msg = { ...s.ctx.msg, userId: "slack:foreign" };
      if (mode === "token") s.ctx.run = { ...s.ctx.run, token: "foreign" };
      const deps =
        mode === "generation"
          ? { ...s.deps, runLedger: { ...s.through, gen: "foreign-generation" } }
          : { ...s.deps, runLedger: s.through };
      await expect(claimRun(deps, s.ctx)).rejects.toThrow();
      expect(claim).not.toHaveBeenCalled();
      expect(s.store.live.get(s.ctx.run.id)).toEqual(saved);
      await s.ctx.reserved.close();
    }
  });
  it("holds the old registry-clock versus reserved-NOW fixture conflict without claim seed or abandonment", async () => {
    const s = await original("null"),
      registry = new RunRegistry({ now: () => NOW + 5000, genId: () => s.ctx.run.id, genToken: () => s.ctx.run.token }),
      run = registry.create("review"),
      saved = structuredClone(s.store.live.get(run.id)),
      claim = vi.spyOn(s.store, "claim"),
      abandon = vi.spyOn(s.store, "abandon");
    await expect(claimRun({ ...s.deps, runLedger: s.through }, { ...s.ctx, registry, run })).rejects.toMatchObject({
      name: "RefusalError",
    });
    expect(claim).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
    expect((await s.store.readTranscript(run.id)).turns).toBe(0);
    expect(s.store.live.get(run.id)).toEqual(saved);
    expect(s.through.liveRuns()).toEqual([s.ctx.reserved]);
    await s.ctx.reserved.close();
  });
  it("holds a legacy reservation with neither snapshot nor receiver identity instead of inventing a new start", async () => {
    const { deps, ledger, base } = setup();
    vi.spyOn(base.registry, "snapshot").mockReturnValue(null);
    await expect(
      claimRun(deps, {
        ...base,
        reserved: new NullLedgerRun(base.run.id, { put: async () => {}, abandoned: () => {} }),
        resume: undefined,
        ledgerRun: undefined,
      }),
    ).rejects.toThrow();
    expect(ledger.opened).toEqual([]);
  });
  it("keeps a legacy matching snapshot without manufacturing an allocation acknowledgment", async () => {
    const { deps, ledger, base } = setup();
    await claimRun(deps, {
      ...base,
      startedAt: NOW,
      reserved: new NullLedgerRun(base.run.id, { put: async () => {}, abandoned: () => {} }),
      resume: undefined,
      ledgerRun: undefined,
    });
    expect(ledger.opened[0]!.startedAt).toBe(NOW);
    expect(ledger.opened[0]!.meta.workspaceAllocation).toBeUndefined();
  });
  it("continues a current-generation reclaimed original without a snapshot and refuses foreign carried identity", async () => {
    for (const mode of ["matching", "generation", "actor", "time", "token"] as const) {
      const s = await original("null");
      await s.ctx.reserved.close();
      s.store.live.get(s.ctx.run.id)!.leaseUntil = 0;
      const [taken] = await s.store.reclaim("gen-reclaimed", NOW + 6000, 30_000);
      const through = createLedgerWriteThrough({
        ledger: s.store,
        gen: "gen-reclaimed",
        now: () => NOW + 6000,
        warn: () => {},
        fallback: new NullRunStore(),
        setInterval: () => ({ unref() {} }),
        clearInterval: () => {},
      });
      const row = structuredClone(taken.row),
        adopted = through.adopt({
          runId: row.runId,
          threadKey: row.threadKey,
          startedAt: row.startedAt,
          meta: row.meta,
          state: row.state,
          lastStep: 0,
          lastSeq: 0,
        });
      vi.spyOn(s.ctx.registry, "snapshot").mockReturnValue(null);
      if (mode === "generation") row.ownerGen = "foreign";
      if (mode === "actor") row.meta.userId = "foreign";
      if (mode === "time") row.startedAt++;
      const run = mode === "token" ? { ...s.ctx.run, token: "foreign" } : s.ctx.run;
      const resume = { row, lastSeq: 0 } as ResumeContext;
      const ctx = { ...s.ctx, run, reserved: undefined, ledgerRun: adopted, carriedRow: row, resume };
      const claim = vi.spyOn(s.store, "claim"),
        saved = structuredClone(s.store.live.get(row.runId));
      if (mode === "matching") {
        expect(await claimRun({ ...s.deps, runLedger: through }, ctx)).toBe(adopted);
        expect(adopted.allocationAck).toBeUndefined();
      } else
        await expect(claimRun({ ...s.deps, runLedger: through }, ctx)).rejects.toMatchObject({ name: "RefusalError" });
      expect(claim).not.toHaveBeenCalled();
      expect(s.store.live.get(row.runId)).toEqual(saved);
      await adopted.close();
    }
  });
  it.each([
    "matching",
    "verified-head",
    "unverified-head",
    "missing-ack",
    "foreign-verification",
    "allocated-head",
    "repo",
    "ref",
    "pr",
    "actor",
    "generation",
    "start",
  ])("re-reserves a reclaimed original with exact fences: %s", async (mode) => {
    const s = await original(mode === "allocated-head" ? "v2" : "null");
    await s.ctx.reserved.close();
    s.store.live.get(s.ctx.run.id)!.leaseUntil = 0;
    const [taken] = await s.store.reclaim("gen-reclaimed", NOW + 6000, 30_000);
    const row = taken.row,
      through = createLedgerWriteThrough({
        ledger: s.store,
        gen: "gen-reclaimed",
        now: () => NOW + 6000,
        warn: () => {},
        fallback: new NullRunStore(),
        setInterval: () => ({ unref() {} }),
        clearInterval: () => {},
      });
    const reserved = await through.reserve({
      runId: row.runId,
      threadKey: row.threadKey,
      startedAt: row.startedAt,
      meta: row.meta,
    });
    if (reserved.kind !== "tracked") throw new Error("fixture restart reserve refused");
    vi.spyOn(s.ctx.registry, "snapshot").mockReturnValue(null);
    const ctx = {
      ...s.ctx,
      reserved: reserved.run,
      carriedRow: row,
      attachedHead: { kind: "allowed" as const, verifiedAtAttach: true, headAdopted: false, repoCtx: s.ctx.repoCtx },
    };
    if (["verified-head", "unverified-head", "allocated-head", "missing-ack", "foreign-verification"].includes(mode)) {
      ctx.repoCtx = { ...ctx.repoCtx, headSha: "b".repeat(40) };
      ctx.attachedHead = { ...ctx.attachedHead, verifiedAtAttach: mode !== "unverified-head", repoCtx: ctx.repoCtx };
      if (mode !== "unverified-head")
        ctx.selection = { ...ctx.selection, binding: { ...ctx.selection.binding, sha: ctx.repoCtx.headSha } };
    }
    if (mode === "missing-ack") vi.spyOn(reserved.run, "allocationAck", "get").mockReturnValue(undefined);
    if (mode === "foreign-verification") ctx.attachedHead.repoCtx = s.ctx.repoCtx;
    if (mode === "repo") ctx.repoCtx = { ...ctx.repoCtx, repo: "acme/foreign" };
    if (mode === "ref") ctx.repoCtx = { ...ctx.repoCtx, ref: "foreign" };
    if (mode === "pr") ctx.repoCtx = { ...ctx.repoCtx, pr: 43 };
    if (mode === "actor") ctx.msg = { ...ctx.msg, userId: "slack:foreign" };
    if (mode === "generation") ctx.carriedRow = { ...row, ownerGen: "foreign" };
    if (mode === "start") ctx.carriedRow = { ...row, startedAt: row.startedAt + 1 };
    if (mode !== "matching" && mode !== "verified-head") {
      const saved = structuredClone(s.store.live.get(row.runId)),
        claim = vi.spyOn(s.store, "claim");
      await expect(claimRun({ ...s.deps, runLedger: through }, ctx)).rejects.toMatchObject({ name: "RefusalError" });
      expect(claim).not.toHaveBeenCalled();
      expect(s.store.live.get(row.runId)).toEqual(saved);
      await reserved.run.close();
      return;
    }
    const claimed = await claimRun({ ...s.deps, runLedger: through }, ctx);
    expect(claimed?.allocationAck).toMatchObject({ startedAt: NOW, gen: "gen-reclaimed", allocation: null });
    expect(s.store.live.get(row.runId)!.meta.workspaceAllocation).toBeUndefined();
    expect(s.store.live.get(row.runId)!.meta.headSha).toBe(ctx.repoCtx.headSha);
    expect(s.store.live.get(row.runId)!.startedAt).toBe(NOW);
    await claimed?.close();
  });
});

describe("claimRun — the ledger claim once the prompt exists", () => {
  it("a same-ID reservation preserves an unknown begun launch instead of minting a prepared one", async () => {
    const { deps, base } = setup();
    const store = new InMemoryRunLedger(() => NOW);
    const through = createLedgerWriteThrough({
      ledger: store,
      gen: "gen-T",
      fallback: new NullRunStore(),
      warn: () => {},
      setInterval: () => ({ unref: () => {} }),
    });
    const meta = {
      agent: base.agent.name,
      model: base.resolved.modelRef,
      channelId: base.msg.channelId,
      userId: base.msg.userId,
      threadKey: THREAD,
      repo: "acme/api",
      ref: "main",
      readonly: false,
      profile: base.profile,
      request: base.requestRow,
    };
    const intent = {
      version: 1,
      harness: "pi",
      phase: "prepared",
      ordinal: 0,
      sessionPolicy: { version: 1, commandRoute: "native", identity: "write" },
    };
    expect(
      await store.claim({
        runId: base.run.id,
        threadKey: THREAD,
        gen: "gen-T",
        startedAt: NOW,
        leaseMs: 30000,
        meta,
        system: "original",
        tools: [],
        state: { harnessLaunch: intent },
      }),
    ).toMatchObject({ ok: true });
    const begun = { ...intent, phase: "begun" };
    expect(await store.setState(base.run.id, "gen-T", { harnessLaunch: begun })).toEqual({ ok: true });
    const reservation = await through.reserve({
      runId: base.run.id,
      threadKey: THREAD,
      startedAt: NOW,
      meta: { ...meta, restartOf: base.run.id },
    });
    if (reservation.kind !== "tracked") throw new Error("original reservation required");
    try {
      const claimed = await claimRun(
        { ...deps, runLedger: through, harness: { harnesses: {} as never, registry: {} as never } },
        {
          ...base,
          messages: [{ role: "user", content: [{ type: "text", text: "fix it" }] }],
          restartOf: base.run.id,
          reserved: reservation.run,
          resume: undefined,
          ledgerRun: undefined,
        },
      );
      expect(claimed?.harnessLaunch).toEqual({
        version: 1,
        harness: "pi",
        phase: "begun",
        ordinal: 0,
        sessionPolicy: { version: 1, commandRoute: "native", identity: "write" },
      });
      expect(store.live.get(base.run.id)?.state.harnessLaunch).toEqual(begun);
    } finally {
      await reservation.run.close();
    }
  });
  it.each(["pi", "opencode"] as const)(
    "records original %s launch intent in the resumable seed before a producer exists",
    async (harness) => {
      const { deps, base } = setup();
      const store = new InMemoryRunLedger(() => NOW);
      const warnings: string[] = [];
      const through = createLedgerWriteThrough({
        ledger: store,
        gen: "gen-T",
        fallback: new NullRunStore(),
        warn: (note) => {
          warnings.push(note);
        },
        setInterval: () => ({ unref: () => {} }),
      });
      const review = getAgent("review");
      const reservation = await through.reserve({
        runId: base.run.id,
        threadKey: THREAD,
        startedAt: NOW,
        meta: {
          agent: review.name,
          model: base.resolved.modelRef,
          channelId: base.msg.channelId,
          userId: base.msg.userId,
          threadKey: THREAD,
          repo: "acme/api",
          ref: "main",
          readonly: true,
          profile: declaredProfile(review),
          request: base.requestRow,
        },
      });
      if (reservation.kind !== "tracked") throw new Error("original reservation required");
      const claimed = await claimRun(
        { ...deps, runLedger: through, harness: { harnesses: {} as never, registry: {} as never } },
        {
          ...base,
          agent: review,
          profile: declaredProfile(review),
          resolved: { ...base.resolved, harness: { name: harness, scope: "defaults" } },
          messages: [{ role: "user", content: [{ type: "text", text: "review the original head" }] }],
          reserved: reservation.run,
          resume: undefined,
          ledgerRun: undefined,
        },
      );
      try {
        expect(claimed?.tracked(), warnings.join("; ")).toBe(true);
        expect(store.live.get(base.run.id)?.state.harnessLaunch).toEqual({
          version: 1,
          harness,
          phase: "prepared",
          ordinal: 0,
          sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "read" },
        });
        expect(claimed?.harnessLaunch).toEqual({
          version: 1,
          harness,
          phase: "prepared",
          ordinal: 0,
          sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "read" },
        });
        expect(claimed?.resumable).toBe(true);
        expect(store.live.get(base.run.id)?.state).not.toHaveProperty("harness");
      } finally {
        await claimed?.close();
      }
    },
  );
  it("promotes a same-ID segment with its raw original baseline, prior push and PR base before writable execution", async () => {
    const { deps, ledger, base } = setup();
    const raw = { version: 1, original: true };
    await claimRun(deps, {
      ...base,
      repoCtx: { repo: "acme/api", ref: "feature/original", baseRef: "release" },
      restartBranchIdentityBaseline: raw,
      restartPushedBranch: "feature/original",
      reserved: new NullLedgerRun(base.run.id, { put: async () => {}, abandoned: () => {} }),
      resume: undefined,
      ledgerRun: undefined,
    });
    expect(ledger.opened[0]!.meta).toMatchObject({ ref: "feature/original", baseRef: "release" });
    expect(ledger.opened[0]!.state).toMatchObject({ branchIdentityBaseline: raw, pushedBranch: "feature/original" });
  });

  it("promotes a reserved accepted target without losing it before reclaim", async () => {
    const { deps, base } = setup();
    const ledger = new InMemoryRunLedger(() => NOW);
    const through = createLedgerWriteThrough({
      ledger,
      gen: "gen-T",
      fallback: new NullRunStore(),
      warn: () => {},
      setInterval: () => ({ unref: () => {} }),
    });
    const operationTarget = { repo: "acme/api", ref: "unit/repair" };
    const reservation = await through.reserve({
      runId: base.run.id,
      threadKey: THREAD,
      startedAt: NOW,
      meta: {
        agent: "coding",
        model: base.resolved.modelRef,
        channelId: base.msg.channelId,
        userId: base.msg.userId,
        threadKey: THREAD,
        repo: "acme/api",
        operationTarget,
        request: { text: base.msg.text },
      },
    });
    expect(reservation.kind).toBe("tracked");
    if (reservation.kind !== "tracked") return;
    expect(ledger.live.get(base.run.id)?.meta.operationTarget).toEqual(operationTarget);
    const claimed = await claimRun(
      { ...deps, runLedger: through },
      {
        ...base,
        operationTarget,
        messages: [{ role: "user", content: [{ type: "text", text: base.msg.text }] }],
        reserved: reservation.run,
        resume: undefined,
        ledgerRun: undefined,
      },
    );
    expect(claimed?.tracked()).toBe(true);
    expect(ledger.live.get(base.run.id)?.phase).toBe("live");
    expect(ledger.live.get(base.run.id)?.meta.operationTarget).toEqual(operationTarget);
    ledger.live.get(base.run.id)!.leaseUntil = 0;
    const [reclaimed] = await ledger.reclaim("gen-NEW", NOW, 30_000);
    expect(carriedOperationTarget(reclaimed.row)).toEqual(operationTarget);
    await claimed?.close();
  });

  it("keeps verified requester DM provenance on the live row", async () => {
    const { deps, ledger, base } = setup();
    const agent = getAgent("orchestrator");
    const directAudience = {
      kind: "slack-unshared-im" as const,
      channelId: "slack:DMAIN",
      userId: "slack:WALICE",
      threadKey: "slack:DMAIN:1.0",
    };
    const msg = { ...base.msg, ...directAudience, directAudience };
    const reserved = new NullLedgerRun("run-c", { put: async () => {}, abandoned: () => {} });
    await claimRun(deps, {
      ...base,
      msg,
      agent,
      profile: declaredProfile(agent),
      repoCtx: { repo: "acme/api", ref: "main", headSha: "a".repeat(40), pr: 41 },
      operationTarget: { repo: "acme/api", ref: "unit/repair" },
      reserved,
      resume: undefined,
      ledgerRun: undefined,
      route: { preset: "orchestrator", reason: "private account balance: 17", model: "anthropic/fast" },
    });
    expect(ledger.opened[0].meta.directAudience).toEqual(directAudience);
    expect(ledger.opened[0].meta.repo).toBeUndefined();
    expect(ledger.opened[0].meta.operationTarget).toBeUndefined();
    expect(ledger.opened[0].meta.ref).toBeUndefined();
    expect(ledger.opened[0].meta.headSha).toBeUndefined();
    expect(ledger.opened[0].meta.pr).toBeUndefined();
    expect(ledger.opened[0].meta.route).toBeUndefined();
  });

  it("keeps repository facts when a non-private main run claims its row", async () => {
    const { deps, ledger, base } = setup();
    const agent = getAgent("orchestrator");
    const reserved = new NullLedgerRun("run-c", { put: async () => {}, abandoned: () => {} });
    const route = { preset: "orchestrator", reason: "public repository summary", model: "anthropic/fast" };
    await claimRun(deps, {
      ...base,
      agent,
      profile: declaredProfile(agent),
      repoCtx: { repo: "acme/api", ref: "main", headSha: "a".repeat(40), pr: 41 },
      reserved,
      resume: undefined,
      ledgerRun: undefined,
      route,
    });
    expect(ledger.opened[0].meta).toMatchObject({
      repo: "acme/api",
      ref: "main",
      headSha: "a".repeat(40),
      pr: 41,
      route,
    });
  });

  it("keeps the relaying app and bound credential identities on the promoted row for restart", async () => {
    for (const identity of [{ postedBy: "slack:bot:B1" }, { authenticatedAs: "mcp:caller" }]) {
      const { deps, ledger, base } = setup();
      const reserved = new NullLedgerRun("run-c", { put: async () => {}, abandoned: () => {} });
      await claimRun(deps, {
        ...base,
        msg: { ...base.msg, ...identity },
        reserved,
        resume: undefined,
        ledgerRun: undefined,
      });
      expect(ledger.opened[0]!.meta).toMatchObject(identity);
    }
  });

  it("persists linked-work tool definitions only for a direct requester Slack DM", async () => {
    const namesFor = async (
      channelId: string,
      channelVisibility: "dm" | "public",
      postedBy?: string,
      attested = true,
    ) => {
      const { deps, ledger, base } = setup();
      deps.coordinatorInstances = new InMemoryCoordinatorInstanceStore();
      deps.plane = async () => ({}) as PlaneService;
      const agent = getAgent("orchestrator");
      const message = {
        ...base.msg,
        channelId,
        threadKey: `${channelId}:1.0`,
        userId: "slack:UDEV",
        ...(postedBy ? { postedBy } : {}),
        ...(attested
          ? {
              directAudience: {
                kind: "slack-unshared-im" as const,
                channelId,
                userId: "slack:UDEV",
                threadKey: `${channelId}:1.0`,
              },
            }
          : {}),
      };
      const reserved = new NullLedgerRun("run-c", { put: async () => {}, abandoned: () => {} });
      await claimRun(deps, {
        ...base,
        msg: message,
        agent,
        profile: declaredProfile(agent),
        channelVisibility,
        verifyDirectAudience: booleanAudienceVerifier(async () => true),
        reserved,
        resume: undefined,
        ledgerRun: undefined,
      });
      return ledger.opened[0]!.tools.map((tool) => tool.name);
    };

    expect(await namesFor("slack:CPUB", "public")).not.toContain("work_status");
    expect(await namesFor("slack:DPRIVATE", "dm", "slack:bot:B1")).not.toContain("work_steer");
    expect(await namesFor("slack:DSHARED", "dm", undefined, false)).not.toContain("work_status");
    expect(await namesFor("slack:DPRIVATE", "dm")).toEqual(
      expect.arrayContaining(["work_status", "work_steer", "work_stop"]),
    );
  });

  it("does not record linked-work tools when the direct audience fails a fresh claim-time check", async () => {
    const { deps, ledger, base } = setup();
    deps.coordinatorInstances = new InMemoryCoordinatorInstanceStore();
    deps.plane = async () => ({}) as PlaneService;
    const agent = getAgent("orchestrator");
    const audience = {
      kind: "slack-unshared-im" as const,
      channelId: "slack:DPRIVATE",
      userId: "slack:UDEV",
      threadKey: "slack:DPRIVATE:1.0",
    };
    const verified = vi.fn(async () => false);
    const reserved = new NullLedgerRun("run-c", { put: async () => {}, abandoned: () => {} });
    const message = {
      ...base.msg,
      channelId: audience.channelId,
      threadKey: audience.threadKey,
      userId: audience.userId,
      directAudience: audience,
    };
    await claimRun(deps, {
      ...base,
      msg: message,
      agent,
      profile: declaredProfile(agent),
      channelVisibility: "dm",
      verifyDirectAudience: booleanAudienceVerifier(verified),
      reserved,
      resume: undefined,
      ledgerRun: undefined,
    });
    expect(verified).toHaveBeenCalledWith(audience);
    expect(ledger.opened[0]!.tools.map((tool) => tool.name).filter((name) => name.startsWith("work_"))).toEqual([]);
  });

  it("keeps a verified direct audience stamp on the promoted row for safe rechecks after restart", async () => {
    const { deps, ledger, base } = setup();
    const audience = {
      kind: "slack-unshared-im" as const,
      channelId: "slack:DPRIVATE",
      userId: "slack:UX",
      threadKey: "slack:DPRIVATE:1.0",
    };
    const reserved = new NullLedgerRun("run-c", { put: async () => {}, abandoned: () => {} });
    const message = {
      ...base.msg,
      channelId: audience.channelId,
      threadKey: audience.threadKey,
      directAudience: audience,
    };
    await claimRun(deps, {
      ...base,
      msg: message,
      reserved,
      resume: undefined,
      ledgerRun: undefined,
    });
    expect(ledger.opened[0]!.meta.directAudience).toEqual(audience);
  });

  it("does not seed a shared-channel orchestrator run with the private progress tool", async () => {
    const { deps, ledger, base } = setup();
    await claimRun(deps, {
      ...base,
      agent: getAgent("orchestrator"),
      reserved: new NullLedgerRun("run-c", { put: async () => {}, abandoned: () => {} }),
      resume: undefined,
      ledgerRun: undefined,
    });
    expect(ledger.opened[0]!.tools.map((tool) => tool.name)).toContain("plane_show");
    expect(ledger.opened[0]!.tools.map((tool) => tool.name)).not.toContain("work_progress");
  });

  it("does not seed a Slack D run with private progress without fresh unshared audience proof", async () => {
    const { deps, ledger, base } = setup();
    deps.coordinatorInstances = new InMemoryCoordinatorInstanceStore();
    deps.privateWorkerLog = new InMemoryPrivateWorkerLog();
    const directAudience = {
      kind: "slack-unshared-im" as const,
      channelId: "slack:DMAIN",
      userId: base.msg.userId,
      threadKey: "slack:DMAIN:1.0",
    };
    const dm = {
      ...base.msg,
      channelId: directAudience.channelId,
      threadKey: directAudience.threadKey,
      directAudience,
    };
    await claimRun(deps, {
      ...base,
      msg: dm,
      io: {
        reply: async () => {},
        status: async () => ({ update: () => {}, done: async () => {} }),
        history: async () => [],
      },
      agent: getAgent("orchestrator"),
      reserved: new NullLedgerRun("run-c", { put: async () => {}, abandoned: () => {} }),
      resume: undefined,
      ledgerRun: undefined,
    });
    expect(ledger.opened[0]!.tools.map((tool) => tool.name)).not.toContain("work_progress");
    expect(ledger.opened[0]!.meta.directAudience).toEqual(directAudience);
  });

  it("a reserved fresh run promotes its reservation: the row carries the identity, the prompt and tools verbatim, the seed, the card, and the hooks; every event from here on is mirrored", async () => {
    const { deps, ledger, registry, run, base } = setup();
    const reserved = new NullLedgerRun("run-c", { put: async () => {}, abandoned: () => {} });
    const out = await claimRun(deps, { ...base, reserved, resume: undefined, ledgerRun: undefined });
    expect(out).toBe(ledger.handle);
    expect(ledger.opened).toHaveLength(1);
    const req = ledger.opened[0];
    expect(req).toMatchObject({
      runId: "run-c",
      threadKey: THREAD,
      meta: {
        agent: "coding",
        model: "anthropic/coding-model",
        repo: "acme/api",
        ref: "main",
        readonly: false,
        selection: "resident",
        workspace: "/w",
        request: { text: "fix it" },
      },
      card: { channel: "CX", ts: "1.0" },
      system: "the system prompt",
      seed: { messages: [], budgetMs: base.agent.maxMinutes * 60_000 },
      reservation: reserved,
    });
    expect(req.tools.map((t) => t.name)).toContain("attach_file"); // the coding toolset, as relayed
    expect(req.onStop).toBeTypeOf("function");
    registry.publish(run.id, { type: "input", messageId: "m1", text: "fix it", at: NOW });
    expect(ledger.handle!.events.map((e) => e.event.type)).toEqual(["input"]);
  });

  it("only a direct requester Slack DM main run advertises private work start to the model", async () => {
    const names = async (visibility: "dm" | "public" | "unknown", attested = true, verifier = true) => {
      const { deps, ledger, base } = setup();
      const agent = getAgent("orchestrator");
      const dmMsg = {
        ...base.msg,
        channelId: "slack:D1",
        threadKey: "slack:D1:1",
        userId: "slack:UADMIN",
        ...(attested
          ? {
              directAudience: {
                kind: "slack-unshared-im" as const,
                channelId: "slack:D1",
                userId: "slack:UADMIN",
                threadKey: "slack:D1:1",
              },
            }
          : {}),
      };
      deps.mainTaskStart = async () => ({ kind: "refused", reply: "fixture" });
      await claimRun(deps, {
        ...base,
        msg: dmMsg,
        privateWorkVerifierAvailable: verifier,
        ...(verifier ? { verifyDirectAudience: booleanAudienceVerifier(async () => true) } : {}),
        agent,
        profile: declaredProfile(agent),
        resolved: { ...base.resolved, agentName: agent.name },
        channelVisibility: visibility,
        reserved: new NullLedgerRun("run-c", { put: async () => {}, abandoned: () => {} }),
        resume: undefined,
        ledgerRun: undefined,
      });
      return ledger.opened[0]!.tools.map((tool) => tool.name);
    };
    expect(await names("dm")).toContain("work_start");
    expect(await names("dm", false)).not.toContain("work_start");
    expect(await names("dm", true, false)).not.toContain("work_start");
    expect(await names("public")).not.toContain("work_start");
    expect(await names("unknown")).not.toContain("work_start");
  });

  // run-history item 48a: the coordinator tag is a fact of the run — the claim
  // publishes it as a typed event, so it lands on the ledger row and a resume
  // after a bot roll reads the plan's base back off the run's own events.

  it("a promotion gone untracked publishes the ledger_untracked note with the why and marks the card through markUntracked — the same label the reserve-time path sets", async () => {
    const { deps, registry, run, base } = setup();
    const ledger = deps.runLedger as RecordingLedger;
    // A promotion whose claim went untracked: the write-through abandoned the
    // row, said why through onUntracked, and answered undefined.
    ledger.open = async (req) => {
      req.onUntracked?.("the claim failed after 3 attempts");
      return { kind: "untracked", why: "the claim failed after 3 attempts" };
    };
    let marked = 0;
    const reserved = new NullLedgerRun("run-c", { put: async () => {}, abandoned: () => {} });
    const out = await claimRun(deps, {
      ...base,
      reserved,
      resume: undefined,
      ledgerRun: undefined,
      markUntracked: () => marked++,
    });
    expect(out).toBeUndefined();
    expect(marked).toBe(1);
    const events: RunEvent[] = [];
    registry.subscribe(run.id, run.token, { onEvent: (event) => void events.push(event) });
    const note = events.find((e) => e.type === "run_note");
    expect(note).toMatchObject({ type: "run_note", kind: "ledger_untracked" });
    expect((note as { summary: string }).summary).toContain("the claim failed after 3 attempts");
  });

  it.each(["off", "fenced", "untracked", "detached"] as const)(
    "a coordinator promotion ending %s refuses setup instead of handing the child to the model",
    async (failure) => {
      const { deps, ledger, base } = setup();
      const reserved = new NullLedgerRun("run-c", { put: async () => {}, abandoned: () => {} });
      ledger.open = async () =>
        failure === "detached"
          ? { kind: "tracked", run: reserved }
          : failure === "untracked"
            ? { kind: "untracked", why: "promotion unavailable" }
            : { kind: failure };
      await expect(
        claimRun(deps, {
          ...base,
          reserved,
          resume: undefined,
          ledgerRun: undefined,
          coordinator: { parentInstanceId: "ship_parent", idempotencyKey: "ship_parent:U12/0/coding" },
        }),
      ).rejects.toMatchObject({
        refusal: { code: "setup_failed", cause: "system", text: expect.stringMatching(/\S/) },
      });
    },
  );

  it("a run the ledger refused to reserve is untracked: no claim is asked, the handle stays undefined", async () => {
    const { deps, ledger, base } = setup();
    expect(
      await claimRun(deps, { ...base, reserved: undefined, resume: undefined, ledgerRun: undefined }),
    ).toBeUndefined();
    expect(ledger.opened).toEqual([]);
  });

  it("a resume keeps the row it adopted at admission and mirrors only what this generation publishes", async () => {
    const { deps, ledger, registry, run, base } = setup();
    const adopted = new RecordingRun("run-c", { put: async () => {}, abandoned: () => {} });
    const resume = { lastSeq: 3 } as unknown as ResumeContext;
    const out = await claimRun(deps, { ...base, reserved: undefined, resume, ledgerRun: adopted });
    expect(out).toBe(adopted);
    expect(ledger.opened).toEqual([]);
    registry.publish(run.id, { type: "input", messageId: "m1", text: "fix it", at: NOW });
    expect(adopted.events.map((e) => e.event.type)).toEqual(["input"]);
  });
});

describe("githubCapabilityFor — the github_* tools' capability for one run", () => {
  it("admits a private repo only for its bound requester in a verified direct DM with current GitHub read permission", async () => {
    const { deps } = setup();
    deps.githubApi = new InMemoryGithubApi({
      "acme/api": { private: false },
      "acme/private": { private: true, permissions: { "ivy-dev": { id: 4242, permission: "read" } } },
    });
    await deps.config.setUserOverride("slack:UDEV", { github: { login: "ivy-dev", id: 4242 } });
    const actor = (channelId: string, postedBy?: string) =>
      chatActorOf(deps.config, {
        userId: "slack:UDEV",
        channelId,
        threadKey: `${channelId}:1.0`,
        ...(postedBy ? { postedBy } : {}),
      });
    const privateDm = { requesterId: "slack:UDEV", verifiedDirectAudience: true };
    const names = async (channelId: string, audience = privateDm, postedBy?: string) =>
      (await githubCapabilityFor(deps, actor(channelId, postedBy), audience).readableRepos?.())?.map((r) => r.fullName);
    expect(await names("slack:DONE")).toEqual(["acme/api", "acme/private"]);
    expect(await names("slack:DONE", { ...privateDm, verifiedDirectAudience: false })).toEqual(["acme/api"]);
    expect(await names("slack:CONE")).toEqual(["acme/api"]);
    expect(await names("slack:DONE", privateDm, "slack:bot:B0CLAUDE")).toEqual(["acme/api"]);
    expect(await names("slack:DONE", { ...privateDm, requesterId: "slack:UOTHER" })).toEqual(["acme/api"]);
    const api = deps.githubApi as InMemoryGithubApi;
    api.repos.set("acme/other", {
      private: true,
      permissions: { "ivy-dev": { id: 4242, permission: "read" } },
      files: {},
      issues: [],
    });
    const checked = vi.spyOn(api, "getUserRepoPermission");
    expect(
      (await githubCapabilityFor(deps, actor("slack:DONE"), privateDm).readableRepos?.(["acme/private"]))?.map(
        (repo) => repo.fullName,
      ),
    ).toEqual(["acme/private"]);
    expect(checked).toHaveBeenCalledExactlyOnceWith("acme/private", "ivy-dev");
    checked.mockRestore();
    api.repos.delete("acme/other");
    await deps.config.setUserOverride("slack:UDEV", { github: { login: "ivy-dev", id: 9999 } });
    expect(await names("slack:DONE")).toEqual(["acme/api"]);
    await deps.config.setUserOverride("slack:UDEV", { github: { login: "ivy-dev", id: 4242 } });
    (deps.githubApi as InMemoryGithubApi).repos.get("acme/private")!.permissions = {
      "ivy-dev": { id: 4242, permission: "none" },
    };
    expect(await names("slack:DONE")).toEqual(["acme/api"]);
  });
  it("limits main-agent reads to public installation repos the resolved requester may use", async () => {
    const { deps } = setup();
    deps.githubApi = new InMemoryGithubApi({
      "acme/api": { private: false },
      "acme/secret": { private: false },
      "acme/private": { private: true },
    });
    const actor = (userId: string) => chatActorOf(deps.config, { userId, channelId: "slack:CX", threadKey: THREAD });
    expect((await githubCapabilityFor(deps, actor("slack:UDEV")).readableRepos?.())?.map((r) => r.fullName)).toEqual([
      "acme/api",
    ]);
    expect((await githubCapabilityFor(deps, actor("slack:UADMIN")).readableRepos?.())?.map((r) => r.fullName)).toEqual([
      "acme/api",
      "acme/secret",
    ]);
  });
  it("pairs the process's API with the requesting actor's per-repo write gate — a relay for an admin writes only where the app may too (item 14)", () => {
    const { deps } = setup();
    const actor = (userId: string, postedBy?: string) =>
      chatActorOf(deps.config, {
        userId,
        channelId: "slack:CX",
        threadKey: "slack:CX:1.0",
        ...(postedBy ? { postedBy } : {}),
      });
    const cap = githubCapabilityFor(deps, actor("slack:UDEV"));
    expect(cap.api).toBe(deps.githubApi);
    expect(cap.canWrite("acme/api")).toBe(true);
    expect(cap.canWrite("acme/secret")).toBe(false);
    expect(githubCapabilityFor(deps, actor("slack:UADMIN")).canWrite("acme/secret")).toBe(true);
    // An app relaying for the admin holds only the Slack baseline: the restricted repo is refused.
    expect(githubCapabilityFor(deps, actor("slack:UADMIN", "slack:bot:B0CLAUDE")).canWrite("acme/secret")).toBe(false);
    expect(githubCapabilityFor(deps, actor("slack:UADMIN", "slack:bot:B0CLAUDE")).canWrite("acme/api")).toBe(true);
  });
});

describe("the shutdown notice", () => {
  afterEach(() => setShutdownNotice(undefined));

  it("is a process-wide value every live frame reads: set by the drain, cleared with undefined", () => {
    expect(shutdownNotice()).toBeUndefined();
    setShutdownNotice(DEPLOY_RESTART_NOTICE);
    expect(shutdownNotice()).toBe("⏸ deploy in progress — this run continues through the bot restart");
    setShutdownNotice(undefined);
    expect(shutdownNotice()).toBeUndefined();
  });
});
