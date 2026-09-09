import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../config.js";
import { getAgent } from "../../agents/registry.js";
import type { ExecutorSelection } from "../../execution/factory.js";
import { NO_CAPABILITIES } from "../capabilities.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import type { RepoContext } from "../repoContext.js";
import { createCardShell } from "../statusCardFrame.js";
import type { ChannelIO, IncomingMessage, StatusHandle, StatusUpdate } from "../types.js";
import type { ResumeContext } from "./admission.js";
import {
  authorizeAgent,
  authorizeAttachedHead,
  authorizePrHead,
  authorizeRepo,
  type AuthorizeDeps,
  type GateCard,
  type GateContext,
} from "./authorize.js";

// Feature: docs/reference/specs/routing-and-config.md item 4, docs/reference/specs/
// resident-repos.md item 29, docs/reference/specs/agent-review.md items 10–11 —
// the authorize stage's own contract, one gate per function, every outcome:
// allowed, or refused with the card closed and the thread told why. What a
// refusal does to the rest of a request (no run, no workspace, the request's
// status) is proven end to end through `dispatch()` in
// `src/core/dispatcher.test.ts`.

const NOW = 10_000;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

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
    review: anthropic/review-model
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
  "slack:UDEV": { actions: ["agent:run:coding"], repos: ["acme/api"] }
restrict:
  agents: [coding]
  repos: ["acme/secret"]
`;

function configStore(): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-authorize-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, YAML);
  return new ConfigStore(path, join(dir, "overrides.json"));
}

const msg = (user = "slack:UX", text = "hello there"): IncomingMessage => ({
  channelId: "slack:CX",
  userId: user,
  threadKey: "slack:CX:1.0",
  text,
});

/** One gate's inputs: a fresh config, a recording channel, a recording refusal
 *  wrap, and an ack card whose closes are kept. */
function setup(over: { user?: string; text?: string; residents?: boolean } = {}) {
  const message = msg(over.user, over.text);
  const replies: string[] = [];
  const io: ChannelIO = {
    reply: async (t) => void replies.push(t),
    status: async () => ({ update: () => {}, done: async () => {} }),
    history: async () => [],
  };
  const refusals: string[] = [];
  const gate: GateContext = {
    msg: message,
    io,
    refuse: async (outcome, fn) => {
      refusals.push(outcome);
      return fn();
    },
  };
  const closes: StatusUpdate[] = [];
  const card: StatusHandle = { update: () => {}, done: async (frame) => void closes.push(frame) };
  const shell = createCardShell({ label: "*review* on `anthropic/review-model`", startedAt: NOW, now: () => NOW });
  const cardCtx: GateCard = { card, shell, closeLines: () => ({}), clock: () => NOW };
  const deps: AuthorizeDeps = {
    config: configStore(),
    capabilities: { ...NO_CAPABILITIES, residents: over.residents ?? true },
  };
  const trace = startRequestRoot({ clock: () => NOW }, { channel: channelOf(message.channelId), receivedAt: NOW });
  return { deps, gate, cardCtx, replies, refusals, closes, root: trace.root, message };
}

/** The reason a closed card carries — somewhere in the frame's text. */
const closedReasons = (closes: StatusUpdate[]) => closes.map((c) => JSON.stringify(c));

describe("authorizeAgent — the agent gate, against the resolved agent", () => {
  it("an unrestricted agent is open to everyone", async () => {
    const { deps, gate, replies, refusals } = setup();
    expect(await authorizeAgent(deps, { ...gate, agentName: "general" })).toEqual({ kind: "allowed" });
    expect(replies).toEqual([]);
    expect(refusals).toEqual([]);
  });

  it("a restricted agent admits a grant holder and refuses everyone else by name, through the dispatch's refusal wrap", async () => {
    const held = setup({ user: "slack:UDEV" });
    expect(await authorizeAgent(held.deps, { ...held.gate, agentName: "coding" })).toEqual({ kind: "allowed" });
    const excluded = setup({ user: "slack:UX" });
    expect(await authorizeAgent(excluded.deps, { ...excluded.gate, agentName: "coding" })).toEqual({
      kind: "refused",
      reason: "agent_allowlist",
    });
    expect(excluded.refusals).toEqual(["agent_allowlist"]);
    expect(excluded.replies).toHaveLength(1);
    expect(excluded.replies[0]).toMatch(
      /^🚫 You're not on the allowlist for the `coding` agent\. Ask .+ for access\.$/,
    );
  });
});

describe("authorizeRepo — the repository gates, once the target has landed", () => {
  const coding = getAgent("coding");

  it("a repo-needing agent whose bare slug the resident registry refused is not started: card closed, the reply says how to onboard — as a command for someone who may, as an ask for everyone else", async () => {
    const admin = setup({ user: "slack:UADMIN" });
    const repoCtx: RepoContext = { rejectedRepo: "acme/new" };
    expect(
      await authorizeRepo(admin.deps, { ...admin.gate, ...admin.cardCtx, agent: coding, needsRepo: true, repoCtx }),
    ).toEqual({
      kind: "refused",
      reason: "repo_not_onboarded",
    });
    expect(admin.refusals).toEqual(["repo_not_onboarded"]);
    expect(closedReasons(admin.closes).join("\n")).toContain("repo not onboarded");
    expect(admin.replies[0]).toContain(
      "📦 `acme/new` is not onboarded as a resident, so I did not start a *coding* run for it. Onboard it (`repo onboard acme/new`)",
    );

    const dev = setup({ user: "slack:UDEV" });
    await authorizeRepo(dev.deps, { ...dev.gate, ...dev.cardCtx, agent: coding, needsRepo: true, repoCtx });
    expect(dev.replies[0]).toMatch(/Ask .+ to onboard it \(`repo onboard acme\/new`\)/);
  });

  it("without a resident fleet there is nothing to onboard: the not-onboarded gate does not apply", async () => {
    const { deps, gate, cardCtx, replies } = setup({ residents: false });
    const repoCtx: RepoContext = { rejectedRepo: "acme/new" };
    expect(await authorizeRepo(deps, { ...gate, ...cardCtx, agent: coding, needsRepo: true, repoCtx })).toEqual({
      kind: "allowed",
    });
    expect(replies).toEqual([]);
  });

  it("a repo the registry did not answer for is not guessed: refused as unverified, with the retry-or-URL reply", async () => {
    const { deps, gate, cardCtx, replies, refusals, closes } = setup({ user: "slack:UADMIN" });
    const repoCtx: RepoContext = { unverifiedRepo: "acme/api" };
    expect(await authorizeRepo(deps, { ...gate, ...cardCtx, agent: coding, needsRepo: true, repoCtx })).toEqual({
      kind: "refused",
      reason: "repo_unverified",
    });
    expect(refusals).toEqual(["repo_unverified"]);
    expect(closedReasons(closes).join("\n")).toContain("repo could not be verified");
    expect(replies[0]).toContain("⚠️ I couldn't verify that `acme/api` is an onboarded repo");
    expect(replies[0]).toContain("https://github.com/acme/api");
  });

  it("a restricted repository refuses a user without a grant for it by name; a granted one, and an unrestricted repository, pass", async () => {
    const excluded = setup({ user: "slack:UDEV" });
    expect(
      await authorizeRepo(excluded.deps, {
        ...excluded.gate,
        ...excluded.cardCtx,
        agent: coding,
        needsRepo: true,
        repoCtx: { repo: "acme/secret" },
      }),
    ).toEqual({ kind: "refused", reason: "repo_access" });
    expect(excluded.refusals).toEqual(["repo_access"]);
    expect(closedReasons(excluded.closes).join("\n")).toContain("repo access");
    expect(excluded.replies[0]).toMatch(/^🚫 You're not on the allowlist for the `acme\/secret` repo environment\./);

    const granted = setup({ user: "slack:UDEV" });
    expect(
      await authorizeRepo(granted.deps, {
        ...granted.gate,
        ...granted.cardCtx,
        agent: coding,
        needsRepo: true,
        repoCtx: { repo: "acme/api" },
      }),
    ).toEqual({
      kind: "allowed",
    });
    const open = setup({ user: "slack:UX" });
    expect(
      await authorizeRepo(open.deps, {
        ...open.gate,
        ...open.cardCtx,
        agent: coding,
        needsRepo: true,
        repoCtx: { repo: "acme/other" },
      }),
    ).toEqual({
      kind: "allowed",
    });
    expect(granted.replies).toEqual([]);
    expect(open.replies).toEqual([]);
  });

  it("an agent that needs no repository is never gated on one", async () => {
    const { deps, gate, cardCtx, replies } = setup({ user: "slack:UX" });
    const repoCtx: RepoContext = { repo: "acme/secret", rejectedRepo: "acme/new", unverifiedRepo: "acme/api" };
    expect(
      await authorizeRepo(deps, { ...gate, ...cardCtx, agent: getAgent("general"), needsRepo: false, repoCtx }),
    ).toEqual({ kind: "allowed" });
    expect(replies).toEqual([]);
  });
});

describe("authorizePrHead — the PR head preflight", () => {
  const review = getAgent("review");
  const text = "review https://github.com/acme/api/pull/41";

  it("a review of a PR whose head could not be resolved is not started: card closed, one named reply", async () => {
    const { gate, cardCtx, replies, refusals, closes } = setup({ text });
    const out = await authorizePrHead({
      ...gate,
      ...cardCtx,
      agent: review,
      directives: { text },
      repoCtx: { repo: "acme/api", pr: 41 },
    });
    expect(out).toEqual({ kind: "refused", reason: "pr_head_unknown" });
    expect(refusals).toEqual(["pr_head_unknown"]);
    expect(closedReasons(closes).join("\n")).toContain("PR head unknown");
    expect(replies[0]).toMatch(/^🔀 Review of acme\/api#41 not started: GitHub did not give me a usable head commit/);
  });

  it("a resolved head, a non-review agent, or no PR at all pass untouched", async () => {
    const pinned = setup({ text });
    expect(
      await authorizePrHead({
        ...pinned.gate,
        ...pinned.cardCtx,
        agent: review,
        directives: { text },
        repoCtx: { repo: "acme/api", pr: 41, headSha: SHA_A },
      }),
    ).toEqual({
      kind: "allowed",
    });
    const coding = setup({ text });
    expect(
      await authorizePrHead({
        ...coding.gate,
        ...coding.cardCtx,
        agent: getAgent("coding"),
        directives: { text },
        repoCtx: { repo: "acme/api", pr: 41 },
      }),
    ).toEqual({
      kind: "allowed",
    });
    const noPr = setup({ text: "review this" });
    expect(
      await authorizePrHead({
        ...noPr.gate,
        ...noPr.cardCtx,
        agent: review,
        directives: { text: "review this" },
        repoCtx: { repo: "acme/api" },
      }),
    ).toEqual({
      kind: "allowed",
    });
    expect([...pinned.replies, ...coding.replies, ...noPr.replies]).toEqual([]);
  });
});

describe("authorizeAttachedHead — the attached-head guard on the resident path", () => {
  const review = getAgent("review");
  const repoCtx: RepoContext = { repo: "acme/api", pr: 41, ref: "feature/x", headSha: SHA_A };

  function selection(over: { sha?: string; resident?: boolean } = {}): {
    selection: ExecutorSelection;
    releases: string[];
  } {
    const releases: string[] = [];
    const executor = {
      release: async (mode: string) => void releases.push(mode),
    } as unknown as ExecutorSelection["executor"];
    const selection: ExecutorSelection = {
      executor,
      resident: over.resident ?? true,
      ...(over.sha !== undefined ? { binding: { ref: "feature/x", sha: over.sha } } : {}),
    };
    return { selection, releases };
  }

  function ctx(
    s: ReturnType<typeof setup>,
    sel: ExecutorSelection,
    over: { resume?: ResumeContext; agent?: ReturnType<typeof getAgent> } = {},
  ) {
    return {
      ...s.gate,
      ...s.cardCtx,
      agent: over.agent ?? review,
      resume: over.resume,
      selection: sel,
      repoCtx,
      root: s.root,
    };
  }

  it("the worktree attached at the PR head: verified, the repo context unchanged", async () => {
    const s = setup();
    const { selection: sel } = selection({ sha: SHA_A });
    expect(await authorizeAttachedHead({ ...s.deps, fetchPrHead: async () => SHA_C }, ctx(s, sel))).toEqual({
      kind: "allowed",
      repoCtx,
      verifiedAtAttach: true,
      headAdopted: false,
    });
    expect(s.replies).toEqual([]);
  });

  it("a push raced the request and the worktree sits at the PR's current head: adopted — the repo context takes that head and the caller re-publishes the run meta", async () => {
    const s = setup();
    const asked: unknown[] = [];
    const { selection: sel } = selection({ sha: SHA_B });
    const out = await authorizeAttachedHead(
      {
        ...s.deps,
        fetchPrHead: async (pr) => {
          asked.push(pr);
          return SHA_B;
        },
      },
      ctx(s, sel),
    );
    expect(out).toEqual({
      kind: "allowed",
      repoCtx: { ...repoCtx, headSha: SHA_B },
      verifiedAtAttach: true,
      headAdopted: true,
    });
    expect(asked).toEqual([{ repo: "acme/api", number: 41 }]);
  });

  it("the branch moved while the worktree was being attached: refused — the pool user released, the card closed, one named reply, no model turn", async () => {
    const s = setup();
    const { selection: sel, releases } = selection({ sha: SHA_B });
    const out = await authorizeAttachedHead({ ...s.deps, fetchPrHead: async () => SHA_C }, ctx(s, sel));
    expect(out).toEqual({ kind: "refused", reason: "branch_moved" });
    expect(s.refusals).toEqual(["branch_moved"]);
    expect(releases).toEqual(["always"]);
    expect(closedReasons(s.closes).join("\n")).toContain("branch moved");
    expect(s.replies[0]).toMatch(
      /^🔀 Review of acme\/api#41 not started: the resident attached `feature\/x` at `bbbbbbb`, but the PR head is `aaaaaaa`/,
    );
  });

  it("no attached sha proves nothing: allowed, not verified; and the guard does not run at all for a non-review agent, a resume, or the sandbox path", async () => {
    const unverified = setup();
    const noSha = selection({});
    expect(await authorizeAttachedHead(unverified.deps, ctx(unverified, noSha.selection))).toEqual({
      kind: "allowed",
      repoCtx,
      verifiedAtAttach: false,
      headAdopted: false,
    });

    const asked: unknown[] = [];
    const deps: AuthorizeDeps = {
      ...unverified.deps,
      fetchPrHead: async () => {
        asked.push(1);
        return SHA_C;
      },
    };
    const moved = selection({ sha: SHA_B });
    const coding = setup();
    expect((await authorizeAttachedHead(deps, ctx(coding, moved.selection, { agent: getAgent("coding") }))).kind).toBe(
      "allowed",
    );
    const resumed = setup();
    const resume = { row: { runId: "run-old" } } as unknown as ResumeContext;
    expect((await authorizeAttachedHead(deps, ctx(resumed, moved.selection, { resume }))).kind).toBe("allowed");
    const sandbox = setup();
    expect(
      (await authorizeAttachedHead(deps, ctx(sandbox, selection({ sha: SHA_B, resident: false }).selection))).kind,
    ).toBe("allowed");
    expect(asked).toEqual([]);
    expect(moved.releases).toEqual([]);
  });
});
