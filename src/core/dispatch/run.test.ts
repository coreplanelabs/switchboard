import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import type { IncomingMessage } from "../types.js";
import { chatActorOf } from "../authz/actor.js";
import type { ResumeContext } from "./admission.js";
import { resolveRun } from "./resolve.js";
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

  // run-history item 48a: the coordinator tag is a fact of the run — the claim
  // publishes it as a typed event, so it lands on the ledger row and a resume
  // after a bot roll reads the plan's base back off the run's own events.
  it("a coordinator's child publishes its tag as a `coordinator_tag` event at the claim — instance, unit and base — mirrored onto the row; a resume republishes nothing", async () => {
    const { deps, ledger, base } = setup();
    const reserved = new NullLedgerRun("run-c", { put: async () => {}, abandoned: () => {} });
    const coordinator = { parentInstanceId: "plan-p-2", idempotencyKey: "plan-p-2:U16/1/coding", base: "feat/trunk" };
    await claimRun(deps, { ...base, reserved, resume: undefined, ledgerRun: undefined, coordinator });
    expect(ledger.handle!.events.map((e) => e.event)).toEqual([
      { type: "coordinator_tag", parentInstanceId: "plan-p-2", unit: "U16", base: "feat/trunk", at: NOW, seq: 1 },
    ]);

    const resumed = setup();
    const adopted = new RecordingRun("run-c", { put: async () => {}, abandoned: () => {} });
    const resume = { lastSeq: 3 } as unknown as ResumeContext;
    await claimRun(resumed.deps, { ...resumed.base, reserved: undefined, resume, ledgerRun: adopted, coordinator });
    expect(adopted.events).toEqual([]);
  });

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
