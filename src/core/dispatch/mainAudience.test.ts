import { describe, expect, it } from "vitest";
import type { SessionSeed } from "./seed.js";
import { mainAudienceAtPrompt, mainAudienceAtReply, planeRowIdentities } from "./mainAudience.js";

const own = [{ server: "metrics", toolCount: 1, audience: "user:slack:UALICE/metrics", revision: "source-a" }];
const base = {
  requester: "slack:UALICE",
  channelId: "slack:DALICE",
  verifiedDirectAudience: true,
  servers: own,
  history: [],
};
const seed = (tool: string): SessionSeed => ({
  messages: [
    { role: "user", content: [{ type: "text", text: "how many signups failed?" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "x", name: tool, input: {} }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "x", content: "17 failed" }] },
    { role: "assistant", content: [{ type: "text", text: "17 failed" }] },
    { role: "user", content: [{ type: "text", text: "fix it" }] },
  ],
  log: { from: 0, turns: 4 },
  notes: [],
});

const verifiedReply = (...args: Parameters<typeof mainAudienceAtReply>) =>
  mainAudienceAtReply(args[0], args[1], args[2], args[3], args[4], args[5], true);

describe("main conversation source audience", () => {
  it("uses the checked full context for compacted notes and handoffs while keeping the private audience gate", () => {
    const input = {
      ...base,
      session: {
        ...seed("mcp__metrics__query"),
        log: { from: 20, turns: 2 },
        summary: "saved findings",
        notepad: "working decisions",
      },
      parentSeed: true,
      threadArtifacts: "verified report",
      contextValidation: { ok: true as const },
    };
    expect(mainAudienceAtPrompt(input).ok).toBe(true);
    expect(mainAudienceAtPrompt({ ...input, verifiedDirectAudience: false }).ok).toBe(false);
    expect(
      mainAudienceAtPrompt({ ...input, contextValidation: { ok: false, code: "saved-context-unproved" } }),
    ).toEqual({ ok: false, code: "saved-context-unproved" });
    expect(mainAudienceAtPrompt({ ...input, contextValidation: undefined }).ok).toBe(false);
  });
  it("distinguishes missing identities, lost access and changed snapshots without source text", () => {
    const current = mainAudienceAtPrompt({ ...base, servers: [] });
    if (!current.ok) throw new Error("fixture must be admitted");
    const check = (
      github: { repos: string[]; current: string[]; unknown: boolean },
      plane?: Parameters<typeof mainAudienceAtReply>[5],
      work?: Parameters<typeof mainAudienceAtReply>[7],
    ) => mainAudienceAtReply(current.audience, [], base.channelId, base.requester, github, plane, true, work);
    const github = { repos: [], current: [], unknown: false };
    expect(check({ ...github, unknown: true })).toEqual({ ok: false, code: "github-identity-unproved" });
    expect(check({ ...github, repos: ["private/repo"] })).toEqual({ ok: false, code: "github-access-lost" });
    expect(check(github, { read: true, unknown: true, exposed: [] })).toEqual({
      ok: false,
      code: "plane-identity-unproved",
    });
    expect(check(github, { read: true, unknown: false, exposed: ["run:hidden"], current: [] })).toEqual({
      ok: false,
      code: "plane-row-no-longer-visible",
    });
    expect(check(github, undefined, { exposed: ["private snapshot"], current: "changed" })).toEqual({
      ok: false,
      code: "thread-work-snapshot-changed",
    });
  });

  it("keeps a web-plane conversation usable when it has no private DM source", () => {
    const input = { ...base, channelId: "web:plane", verifiedDirectAudience: false, servers: [] };
    const current = mainAudienceAtPrompt(input);
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(
      mainAudienceAtReply(current.audience, [], input.channelId, input.requester, {
        repos: [],
        current: [],
        unknown: false,
      }).ok,
    ).toBe(true);
  });
  it("refuses an unverified DM before a private source or plane answer can be admitted", () => {
    expect(mainAudienceAtPrompt({ ...base, verifiedDirectAudience: false }).ok).toBe(false);
    const current = mainAudienceAtPrompt(base);
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(
      mainAudienceAtReply(
        current.audience,
        own,
        base.channelId,
        base.requester,
        {
          repos: [],
          current: [],
          unknown: false,
        },
        undefined,
        false,
      ).ok,
    ).toBe(false);
  });
  it("refuses saved MCP evidence even when a replacement uses the same name and requester", () => {
    expect(mainAudienceAtPrompt({ ...base, session: seed("mcp__metrics__query") }).ok).toBe(false);
    const current = mainAudienceAtPrompt(base);
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(
      verifiedReply(current.audience, own, base.channelId, base.requester, {
        repos: [],
        current: [],
        unknown: false,
      }).ok,
    ).toBe(true);
    expect(
      verifiedReply(current.audience, [], base.channelId, base.requester, {
        repos: [],
        current: [],
        unknown: false,
      }).ok,
    ).toBe(false);
    expect(
      verifiedReply(current.audience, [{ server: "metrics", toolCount: 1 }], base.channelId, base.requester, {
        repos: [],
        current: [],
        unknown: false,
      }).ok,
    ).toBe(false);
  });

  it("withholds this run's answer when the same named MCP source is replaced before publication", () => {
    const current = mainAudienceAtPrompt(base);
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    const github = { repos: [], current: [], unknown: false };
    expect(verifiedReply(current.audience, own, base.channelId, base.requester, github).ok).toBe(true);
    expect(
      verifiedReply(current.audience, [{ ...own[0], revision: "source-b" }], base.channelId, base.requester, github).ok,
    ).toBe(false);
    expect(
      verifiedReply(current.audience, [{ ...own[0], revision: undefined }], base.channelId, base.requester, github).ok,
    ).toBe(false);
  });

  it("withholds a current GitHub answer after a repo grant is revoked or its repository is unknown", () => {
    const prior = mainAudienceAtPrompt({ ...base, servers: [] });
    expect(prior.ok).toBe(true);
    if (!prior.ok) return;
    expect(
      verifiedReply(prior.audience, [], base.channelId, base.requester, {
        repos: ["acme/public"],
        current: ["acme/public"],
        unknown: false,
      }).ok,
    ).toBe(true);
    expect(
      verifiedReply(prior.audience, [], base.channelId, base.requester, {
        repos: ["acme/public"],
        current: [],
        unknown: false,
      }).ok,
    ).toBe(false);
    expect(
      verifiedReply(prior.audience, [], base.channelId, base.requester, { repos: [], current: [], unknown: true }).ok,
    ).toBe(false);
    expect(
      verifiedReply(prior.audience, [], base.channelId, base.requester, {
        repos: [""],
        current: [],
        unknown: false,
      }).ok,
    ).toBe(false);
  });

  it("denies a shared channel, a foreign author or run, and an unknown source audience", () => {
    expect(mainAudienceAtPrompt({ ...base, channelId: "slack:C1" }).ok).toBe(false);
    expect(mainAudienceAtPrompt({ ...base, history: [{ role: "user", text: "hello", user: "slack:UBOB" }] }).ok).toBe(
      false,
    );
    expect(
      mainAudienceAtPrompt({ ...base, thread: [{ id: "r1", startedAt: 1, finished: true, eventCount: 0 }] }).ok,
    ).toBe(false);
    expect(mainAudienceAtPrompt({ ...base, servers: [{ server: "metrics", toolCount: 1 }] }).ok).toBe(false);
    expect(mainAudienceAtPrompt({ ...base, threadArtifacts: "earlier private source answer" }).ok).toBe(false);
  });

  it("denies earlier source data after source loss and any truncated or compacted seed", () => {
    expect(mainAudienceAtPrompt({ ...base, servers: [], session: seed("mcp__metrics__query") }).ok).toBe(false);
    expect(
      mainAudienceAtPrompt({ ...base, session: { ...seed("mcp__metrics__query"), log: { from: 9, turns: 4 } } }).ok,
    ).toBe(false);
    expect(
      mainAudienceAtPrompt({ ...base, session: { ...seed("mcp__metrics__query"), summary: "17 failed" } }).ok,
    ).toBe(false);
    expect(mainAudienceAtPrompt({ ...base, servers: [], history: [{ role: "assistant", text: "17 failed" }] }).ok).toBe(
      false,
    );
  });

  it("allows context without private reads in a shared channel", () => {
    expect(mainAudienceAtPrompt({ ...base, channelId: "slack:C1", servers: [], session: seed("recall") }).ok).toBe(
      true,
    );
  });

  it("refuses a saved plane result after its requester-visible rows may have changed", () => {
    expect(mainAudienceAtPrompt({ ...base, servers: [], session: seed("plane_show") }).ok).toBe(false);
  });

  it("refuses a saved thread work result on a later turn or resumed run", () => {
    expect(mainAudienceAtPrompt({ ...base, servers: [], session: seed("thread_work") }).ok).toBe(false);
    const resumed = {
      kind: "resume" as const,
      messages: seed("thread_work").messages,
      originalToolNames: ["thread_work"],
      originalAudienceChecked: true,
      compacted: false,
      requester: base.requester,
      channelId: base.channelId,
    };
    expect(mainAudienceAtPrompt({ ...base, servers: [], resumed }).ok).toBe(false);
  });

  it("withholds a current thread work answer when the fresh durable view loses a linked unit", () => {
    const first = mainAudienceAtPrompt({ ...base, servers: [] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const github = { repos: [], current: [], unknown: false };
    const prior = '{"units":[{"unit":"one","pr":"acme/api#7"}]}';
    const gone = '{"units":[]}';
    expect(
      mainAudienceAtReply(first.audience, [], base.channelId, base.requester, github, undefined, true, {
        exposed: [prior],
        current: prior,
      }).ok,
    ).toBe(true);
    expect(
      mainAudienceAtReply(first.audience, [], base.channelId, base.requester, github, undefined, true, {
        exposed: [prior],
        current: gone,
      }).ok,
    ).toBe(false);
    expect(
      mainAudienceAtReply(first.audience, [], base.channelId, base.requester, github, undefined, true, {
        exposed: [prior, gone],
        current: gone,
      }).ok,
    ).toBe(false);
    expect(
      mainAudienceAtReply(first.audience, [], base.channelId, base.requester, github, undefined, true, {
        exposed: [prior],
      }).ok,
    ).toBe(false);
  });

  it("withholds a current plane answer when any exposed run, unit or PR disappears", () => {
    const first = mainAudienceAtPrompt({ ...base, servers: [] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const github = { repos: [], current: [], unknown: false };
    const exposed = ["run:r1", "unit:instance:task", "pr:acme/api#7"];
    expect(
      verifiedReply(first.audience, [], base.channelId, base.requester, github, {
        read: true,
        exposed,
        current: exposed,
        unknown: false,
      }).ok,
    ).toBe(true);
    for (const gone of exposed) {
      expect(
        verifiedReply(first.audience, [], base.channelId, base.requester, github, {
          read: true,
          exposed,
          current: exposed.filter((id) => id !== gone),
          unknown: false,
        }).ok,
      ).toBe(false);
    }
  });

  it("records full plane run, unit and PR identities for requester visibility rechecks", () => {
    const identities = planeRowIdentities({
      at: 1,
      runs: [{ run: { id: "run-full-identity", startedAt: 1, finished: true, eventCount: 0 }, owner: {}, health: [] }],
      units: [
        {
          unit: {
            unit: "instance:task",
            instanceId: "instance",
            id: "task",
            branch: "fix",
            threads: {},
            sourceUrls: {},
            rounds: [],
          },
          instance: { id: "instance", repo: "acme/api", createdAt: 1 },
          health: [],
        },
      ],
      pullRequests: [{ pr: { repo: "Acme/API", number: 7 }, owner: {}, health: [] }],
      windows: [],
      findings: [],
    });
    expect(identities).toEqual({
      rows: ["run:run-full-identity", "unit:instance:task", "pr:acme/api#7"],
      unknown: false,
    });
  });

  it("refuses saved GitHub reads after a requester grant may have changed", () => {
    expect(mainAudienceAtPrompt({ ...base, servers: [], session: seed("github_file") }).ok).toBe(false);
    expect(mainAudienceAtPrompt({ ...base, servers: [], session: seed("github_repos") }).ok).toBe(false);
  });

  it("refuses a spawned main agent's parent seed before its first model turn", () => {
    expect(mainAudienceAtPrompt({ ...base, parentSeed: true }).ok).toBe(false);
  });

  it("refuses a resumed private MCP result before the model can replay it, even if the same source name is still served", () => {
    const resumed = {
      kind: "resume" as const,
      messages: seed("mcp__metrics__query").messages,
      originalToolNames: ["mcp__metrics__query"],
      originalAudienceChecked: true,
      compacted: false,
      requester: base.requester,
      channelId: base.channelId,
    };
    expect(mainAudienceAtPrompt({ ...base, servers: [], resumed }).ok).toBe(false);
    expect(mainAudienceAtPrompt({ ...base, resumed }).ok).toBe(false);
    expect(mainAudienceAtPrompt({ ...base, resumed: { ...resumed, originalToolNames: [] } }).ok).toBe(false);
  });

  it("refuses a resumed Slack context result before replay even without a session seed", () => {
    const resumed = {
      kind: "resume" as const,
      messages: seed("slack_context").messages,
      originalToolNames: ["slack_context"],
      originalAudienceChecked: true,
      compacted: false,
      requester: base.requester,
      channelId: base.channelId,
    };
    expect(mainAudienceAtPrompt({ ...base, servers: [], resumed }).ok).toBe(false);
    expect(mainAudienceAtPrompt({ ...base, servers: [], resumed: { ...resumed, originalToolNames: [] } }).ok).toBe(
      false,
    );
  });

  it("refuses a resumed source tool catalog, compaction, finish, or changed requester before publication", () => {
    const resumed = {
      kind: "resume" as const,
      messages: seed("plane_show").messages,
      originalToolNames: ["plane_show"],
      originalAudienceChecked: true,
      compacted: false,
      requester: base.requester,
      channelId: base.channelId,
    };
    expect(
      mainAudienceAtPrompt({ ...base, resumed: { ...resumed, originalToolNames: ["mcp__metrics__query"] } }).ok,
    ).toBe(false);
    expect(mainAudienceAtPrompt({ ...base, resumed: { ...resumed, compacted: true } }).ok).toBe(false);
    expect(mainAudienceAtPrompt({ ...base, resumed: { ...resumed, originalAudienceChecked: false } }).ok).toBe(false);
    expect(mainAudienceAtPrompt({ ...base, resumed: { ...resumed, kind: "finish" } }).ok).toBe(false);
    expect(mainAudienceAtPrompt({ ...base, resumed: { ...resumed, requester: "slack:UBOB" } }).ok).toBe(false);
    expect(mainAudienceAtPrompt({ ...base, resumed: { ...resumed, channelId: "slack:DBOB" } }).ok).toBe(false);
    expect(mainAudienceAtPrompt({ ...base, resumed: { ...resumed, messages: resumed.messages.slice(2) } }).ok).toBe(
      false,
    );
    expect(mainAudienceAtPrompt({ ...base, servers: [], resumed }).ok).toBe(false);
  });

  it("refuses a resumed GitHub result before the model or answer sees a revoked repo", () => {
    const resumed = {
      kind: "resume" as const,
      messages: seed("github_file").messages,
      originalToolNames: ["github_file"],
      originalAudienceChecked: true,
      compacted: false,
      requester: base.requester,
      channelId: base.channelId,
    };
    expect(mainAudienceAtPrompt({ ...base, servers: [], resumed }).ok).toBe(false);
  });
});
