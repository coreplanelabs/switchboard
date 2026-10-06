import { booleanAudienceVerifier } from "../testing/audienceVerifier.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../config.js";
import { getAgent } from "../../agents/registry.js";
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
  const registry = new RunRegistry({ genId: () => "run-c", genToken: () => "tok" });
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

describe("claimRun — the ledger claim once the prompt exists", () => {
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
      { ...base, operationTarget, reserved: reservation.run, resume: undefined, ledgerRun: undefined },
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
