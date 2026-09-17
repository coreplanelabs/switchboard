import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getAgent } from "../../agents/registry.js";
import { ConfigStore } from "../../config.js";
import { declaredProfile } from "../../config/profile.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import {
  HarnessContainerReplacedError,
  HarnessInterruptedError,
  RELAUNCH_CEILING,
  type HarnessFacts,
  type HarnessRecord,
} from "../harness/contract.js";
import { bearerHashOf, RunBearerStore } from "../modelProxy/runBearers.js";
import type { RepoContext } from "../repoContext.js";
import { prepareRelaunch, RelaunchRefusedError } from "./relaunch.js";

// The re-attach as the run's stop ends it: the provision stage's own answer
// (`stopped`, provision.test.ts proves the mapping) handed to the relaunch,
// with the context the relaunch passed kept for the test.
const reattachState = vi.hoisted(() => ({
  answer: undefined as { kind: "stopped" } | undefined,
  contexts: [] as Array<{ stopSignal?: AbortSignal }>,
}));
vi.mock("./provision.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./provision.js")>();
  return {
    ...mod,
    reattachWorkspace: async (
      deps: Parameters<typeof mod.reattachWorkspace>[0],
      ctx: Parameters<typeof mod.reattachWorkspace>[1],
    ) => {
      reattachState.contexts.push({ stopSignal: ctx.stopSignal });
      return reattachState.answer ?? mod.reattachWorkspace(deps, ctx);
    },
  };
});

// Feature: docs/reference/specs/harness.md item 6 (the survival clause's
// ceiling), docs/reference/specs/model-proxy.md item 2 (a relaunch rotates),
// docs/reference/specs/run-history.md item 54 (the re-attach mid-run) — the
// relaunch decided and prepared by name: the bound, the workspace, the
// rotation with the row written inside it, the resume the harness rebuilds from.

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
`;

function deps(extra = "") {
  const dir = mkdtempSync(join(tmpdir(), "swb-relaunch-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, `${YAML}workspaceDir: ${dir}\n${extra}`);
  const config = new ConfigStore(path, join(dir, "overrides.json"));
  const runBearers = new RunBearerStore({ clock: () => NOW });
  return { config, dataDir: join(dir, "data"), runBearers, dir };
}

const record: HarnessRecord = {
  messages: [
    { role: "user", content: [{ type: "text", text: "fix it" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "npm test" } }] },
  ],
  compactions: [],
  settlements: [
    {
      toolUse: { type: "tool_use", id: "c1", name: "bash", input: { command: "npm test" } },
      action: "synthetic",
      text: "The container running pi was replaced while this bash call was in flight; its result was lost.",
    },
  ],
  turn: 1,
  inboxConsumedSeq: 3,
  deadline: NOW + 20 * 60_000,
};

const replaced = new HarnessContainerReplacedError(
  "the container running pi was replaced (vm-old → vm-new; the executor said: restarted)",
  "restarted",
  "vm-old",
  "vm-new",
  record,
);

const facts = (relaunches: number, bearerHash?: string): HarnessFacts => ({
  harness: "pi",
  pid: 4242,
  logOffset: 120,
  root: "/tmp/switchboard-pi-run-1",
  container: "vm-old",
  relaunches,
  ...(bearerHash !== undefined ? { bearerHash } : {}),
});

function context(over: Partial<Parameters<typeof prepareRelaunch>[1]> = {}) {
  const saves: HarnessFacts[] = [];
  const agent = getAgent("coding");
  const trace = startRequestRoot({ clock: () => NOW }, { channel: channelOf("slack:CX"), receivedAt: NOW });
  const ctx: Parameters<typeof prepareRelaunch>[1] = {
    runId: "run-1",
    threadKey: THREAD,
    agent,
    profile: declaredProfile(agent),
    repoCtx: { repo: "acme/api", ref: "main" } as RepoContext,
    root: trace.root,
    clock: () => NOW + 30_000,
    harness: { name: "pi", history: "authored-session" },
    replaced,
    facts: facts(0),
    binding: undefined,
    saveFacts: (f) => void saves.push(f),
    ...over,
  };
  return { ctx, saves };
}

const grant = (store: RunBearerStore, runId = "run-1") =>
  store.mint({
    runId,
    modelRef: "anthropic/m",
    providerName: "anthropic",
    providerType: "anthropic",
    model: "m",
    maxTokens: 4096,
    maxTurns: 50,
    expiresAt: NOW + 60 * 60_000,
    span: startRequestRoot({ clock: () => NOW }, { channel: channelOf("slack:CX"), receivedAt: NOW }).root,
    publish: () => {},
  });

describe("prepareRelaunch — the relaunch decided and prepared", () => {
  it("relaunches: the bearer rotated on the run's own meter with the row written exactly once inside the rotation — the new hash, the count one higher, nothing else changed — the old bearer refused, the resume the record with the budget left from the deadline, the rotated facts and the two containers' words; the workspace re-attached where the row says", async () => {
    const d = deps();
    const old = grant(d.runBearers);
    d.runBearers.consumeTurn("run-1");
    d.runBearers.consumeTurn("run-1");
    const { ctx, saves } = context({ facts: facts(0, bearerHashOf(old)), binding: { backend: "local" } });
    const decision = await prepareRelaunch(d, ctx);
    if (decision.kind !== "relaunch")
      throw new Error(decision.kind === "refused" ? decision.interruption.message : decision.kind);
    // The row: one write, inside the rotation, the new hash and the count.
    expect(saves).toHaveLength(1);
    expect(saves[0]).toEqual({ ...facts(1), bearerHash: bearerHashOf(decision.bearer!) });
    expect(saves[0]!.bearerHash).not.toBe(bearerHashOf(old));
    // The meter: the turns spent, the expiry and one secret, the new; the old refused.
    expect(d.runBearers.verify(old)).toEqual({ ok: false, reason: "unknown_bearer", runId: "run-1" });
    expect(d.runBearers.verify(decision.bearer!)).toMatchObject({ ok: true, turns: 2 });
    expect(d.runBearers.grantOf("run-1")).toMatchObject({ turns: 2, bearers: 1, revoked: false });
    // The resume: the record, the budget as the clock reads it now, the rotated facts, the relaunch's words.
    expect(decision.resume).toEqual({
      messages: record.messages,
      compactions: [],
      settlements: record.settlements,
      turn: 1,
      inboxConsumedSeq: 3,
      remainingMs: 20 * 60_000 - 30_000,
      facts: saves[0],
      relaunch: { from: "vm-old", to: "vm-new" },
    });
    // The workspace: the recorded local backend re-attached, the thread's directory.
    expect(decision.round?.selection.backend).toBe("local");
    expect((await decision.round!.selection.executor.exec("pwd")).trim().endsWith("slack_CX_1.0")).toBe(true);
  });

  it("without a bearer store the row is still written once with the count one higher and the hash it had, and no bearer is handed back", async () => {
    const d = deps();
    const { ctx, saves } = context({ facts: facts(1, "ab".repeat(32)) });
    const decision = await prepareRelaunch({ config: d.config, dataDir: d.dataDir }, ctx);
    if (decision.kind !== "relaunch")
      throw new Error(decision.kind === "refused" ? decision.interruption.message : decision.kind);
    expect(saves).toEqual([facts(2, "ab".repeat(32))]);
    expect(decision.bearer).toBeUndefined();
    expect(decision.round).toBeUndefined();
    expect(decision.resume.facts).toEqual(facts(2, "ab".repeat(32)));
  });

  it("refuses by name, writing nothing: the ceiling reached (the reason names the bound), a row without facts, a harness that keeps its own store, a bearer that cannot be rotated — each an interruption with the refusal container_replaced", async () => {
    const d = deps();
    const refused = async (over: Partial<Parameters<typeof prepareRelaunch>[1]>, store = d.runBearers) => {
      const { ctx, saves } = context(over);
      const decision = await prepareRelaunch({ config: d.config, dataDir: d.dataDir, runBearers: store }, ctx);
      if (decision.kind !== "refused") throw new Error("expected a refusal");
      expect(saves).toEqual([]);
      expect(decision.interruption).toBeInstanceOf(RelaunchRefusedError);
      expect(decision.interruption).toBeInstanceOf(HarnessInterruptedError);
      // The message starts at the why: the verdict is the harness's own note already.
      expect(decision.interruption.message).not.toContain(replaced.message);
      expect(decision.interruption.message).toMatch(/the run restarts from its request/);
      return decision.interruption;
    };
    const ceiling = await refused({ facts: facts(RELAUNCH_CEILING) });
    expect(ceiling.reason).toBe(
      `relaunch ceiling: ${RELAUNCH_CEILING} relaunches already; restarting from the request`,
    );
    expect(ceiling.refusal).toBe("container_replaced");
    expect(ceiling.message).toContain(
      `the relaunch ceiling is ${RELAUNCH_CEILING} (2 relaunches already), so pi is not started a fourth time`,
    );
    const noFacts = await refused({ facts: undefined });
    expect(noFacts.reason).toBe(
      "container replaced under the run before its process left facts; restarting from the request",
    );
    const ownStore = await refused({ harness: { name: "opencode", history: "own-store" } });
    expect(ownStore.reason).toBe(
      "container replaced under the run; the harness keeps its own store; restarting from the request",
    );
    expect(ownStore.message).toContain("the opencode harness keeps its own store, which went with the container");
    grant(d.runBearers);
    d.runBearers.revoke("run-1");
    const revoked = await refused({});
    expect(revoked.reason).toBe("the run's bearer could not be rotated (revoked); restarting from the request");
    const never = await refused({}, new RunBearerStore({ clock: () => NOW }));
    expect(never.reason).toBe("the run's bearer could not be rotated (unknown_run); restarting from the request");
  });

  it("a workspace refused by name is the refusal workspace_lost, decided before the rotation: nothing is written and the run's bearers stand", async () => {
    const d = deps();
    const old = grant(d.runBearers);
    const { ctx, saves } = context({
      binding: { backend: "resident", workspace: "/workspace/threads/t/main", user: "worker2" },
    });
    const decision = await prepareRelaunch(d, ctx);
    if (decision.kind !== "refused") throw new Error("expected a refusal");
    expect(decision.interruption.refusal).toBe("workspace_lost");
    expect(decision.interruption.reason).toBe(
      "workspace lost with the replaced container; restarting from the request",
    );
    expect(decision.interruption.message).toBe(
      "the run's workspace could not be re-attached in the replacement container (no resident backend is configured in this process); the run restarts from its request as a new run in this thread",
    );
    expect(saves).toEqual([]);
    expect(d.runBearers.verify(old).ok).toBe(true);
    expect(d.runBearers.grantOf("run-1")?.bearers).toBe(1);
  });

  it("a run inside its write-up reserve is the decision `lease_spent`, before any request and before the rotation: the workspace is never asked for, nothing is written, the run's bearers stand, and the why names the clock — never `workspace_lost`, never a restart from the request (execution.md item 9)", async () => {
    const d = deps();
    const old = grant(d.runBearers);
    const { ctx, saves } = context({
      binding: { backend: "resident", workspace: "/workspace/threads/t/main", user: "worker2" },
      remainingMs: () => 30_000,
    });
    const decision = await prepareRelaunch(d, ctx);
    expect(decision).toEqual({
      kind: "lease_spent",
      why: "the container was replaced with 30s of the run's lease left, inside the write-up reserve; no re-attach was opened and no write-up ran",
    });
    expect(saves).toEqual([]);
    expect(d.runBearers.verify(old).ok).toBe(true);
    // With the lease still running (or not started) the same context is the refusal it was.
    const running = await prepareRelaunch(d, context({ ...ctx, remainingMs: () => 10 * 60_000 }).ctx);
    expect(running.kind).toBe("refused");
    const unstarted = await prepareRelaunch(d, context({ ...ctx, remainingMs: () => undefined }).ctx);
    expect(unstarted.kind).toBe("refused");
  });

  it("the run's hard stop rides into the re-attach, and a stop that ended its wait is the decision `stopped`, before the rotation: nothing is written, the bearers stand, nothing relaunches and nothing restarts", async () => {
    const d = deps();
    const old = grant(d.runBearers);
    const control = new AbortController();
    reattachState.answer = { kind: "stopped" };
    try {
      const { ctx, saves } = context({
        binding: { backend: "resident", workspace: "/workspace/threads/t/main", user: "worker2" },
        stopSignal: control.signal,
      });
      const decision = await prepareRelaunch(d, ctx);
      expect(decision).toEqual({ kind: "stopped" });
      expect(reattachState.contexts.at(-1)?.stopSignal).toBe(control.signal);
      expect(saves).toEqual([]);
      expect(d.runBearers.verify(old).ok).toBe(true);
      expect(d.runBearers.grantOf("run-1")?.bearers).toBe(1);
    } finally {
      reattachState.answer = undefined;
    }
  });

  it("a row write that throws inside the rotation propagates as the failure it is: nothing is relaunched, and the store keeps both secrets verifying", async () => {
    const d = deps();
    const old = grant(d.runBearers);
    const { ctx } = context({
      saveFacts: () => {
        throw new Error("the ledger is unreachable");
      },
    });
    await expect(prepareRelaunch(d, ctx)).rejects.toThrow("the ledger is unreachable");
    expect(d.runBearers.verify(old)).toMatchObject({ ok: true });
    expect(d.runBearers.grantOf("run-1")).toMatchObject({ bearers: 2, revoked: false });
  });
});
