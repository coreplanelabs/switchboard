import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../config.js";
import { getAgent } from "../../agents/registry.js";
import { InMemoryGithubApi } from "../../execution/githubApi.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import { RunRegistry } from "../runRegistry.js";
import type { RunEvent } from "../runEvents.js";
import {
  NullLedgerRun,
  NullLedgerWriteThrough,
  type LedgerRun,
  type OpenRunRequest,
} from "../runLedger/writeThrough.js";
import { NullRunHistoryWriter } from "../runHistoryWriter.js";
import { NullRunStore } from "../runStore.js";
import type { IncomingMessage } from "../types.js";
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
  override async open(req: OpenRunRequest): Promise<LedgerRun | undefined> {
    this.opened.push(req);
    this.handle = new RecordingRun(req.runId, { put: async () => {} });
    return this.handle;
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
    githubApi: new InMemoryGithubApi(),
  };
  const message = msg("agent:coding fix it");
  const { resolved } = resolveRun(
    { config, providers: { get: () => ({}) as never } as never },
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
    const reserved = new NullLedgerRun("run-c", { put: async () => {} });
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
    expect(req.tools.map((t) => t.name)).toContain("bash");
    expect(req.onStop).toBeTypeOf("function");
    registry.publish(run.id, { type: "input", text: "fix it", at: NOW });
    expect(ledger.handle!.events.map((e) => e.event.type)).toEqual(["input"]);
  });

  it("a run the ledger refused to reserve is untracked: no claim is asked, the handle stays undefined", async () => {
    const { deps, ledger, base } = setup();
    expect(
      await claimRun(deps, { ...base, reserved: undefined, resume: undefined, ledgerRun: undefined }),
    ).toBeUndefined();
    expect(ledger.opened).toEqual([]);
  });

  it("a resume keeps the row it adopted at admission and mirrors only what this generation publishes", async () => {
    const { deps, ledger, registry, run, base } = setup();
    const adopted = new RecordingRun("run-c", { put: async () => {} });
    const resume = { lastSeq: 3 } as unknown as ResumeContext;
    const out = await claimRun(deps, { ...base, reserved: undefined, resume, ledgerRun: adopted });
    expect(out).toBe(adopted);
    expect(ledger.opened).toEqual([]);
    registry.publish(run.id, { type: "input", text: "fix it", at: NOW });
    expect(adopted.events.map((e) => e.event.type)).toEqual(["input"]);
  });
});

describe("githubCapabilityFor — the github_* tools' capability for one run", () => {
  it("pairs the process's API with the requesting user's per-repo write gate", () => {
    const { deps } = setup();
    const cap = githubCapabilityFor(deps, "slack:UDEV");
    expect(cap.api).toBe(deps.githubApi);
    expect(cap.canWrite("acme/api")).toBe(true);
    expect(cap.canWrite("acme/secret")).toBe(false);
    expect(githubCapabilityFor(deps, "slack:UADMIN").canWrite("acme/secret")).toBe(true);
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
