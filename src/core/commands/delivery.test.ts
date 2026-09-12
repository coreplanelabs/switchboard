import { describe, expect, it } from "vitest";
import { CommandRegistry, bindCommands, renderText, type Caller } from "../commandRegistry.js";
import {
  createDeliveryService,
  InMemoryDeliverySource,
  NullDeliveryService,
  type PullRequestFacts,
} from "../delivery.js";
import { RunRegistry } from "../runRegistry.js";
import { InMemoryRunStore } from "../runStore.js";
import { createRunsService } from "../runsService.js";
import { callerWith } from "../testing/callers.js";
import { deliveryReport, registerDeliveryCommands, type DeliveryCommandDeps } from "./delivery.js";
import { ALL_CAPABILITIES } from "../capabilities.js";
import { NO_CAPABILITIES } from "../capabilities.js";
import type { RunRecord } from "../runRecord.js";
import { analyzeRunFriction } from "../runFriction.js";

// Feature: docs/reference/specs/delivery.md — `delivery report`: the indicators
// over a repository's merged pull requests and the caller's own run history,
// on every surface, with nothing written.

const NOW = Date.parse("2026-09-11T20:00:00Z");
const REVIEWER = "acme-review[bot]";
/** Holds the command's grant and `runs:read` over every channel (a list of actions means all channels). */
const operator: Caller = callerWith("access", "access:op", ["delivery:read", "runs:read"]);
/** Holds the command's grant and no channel: the runs predicate admits nothing but the caller's own runs. */
const noRuns: Caller = callerWith("access", "access:viewer", { actions: new Set(["delivery:read"]) });

const pr = (number: number, over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  number,
  title: `change ${number}`,
  author: "alice",
  createdAt: "2026-09-10T23:59:09Z",
  mergedAt: "2026-09-11T00:18:40Z",
  firstHeadSha: "28837ecbdc07dd578743919c3a071dcd3756a47a",
  ci: [
    {
      headSha: "28837ecbdc07dd578743919c3a071dcd3756a47a",
      trigger: "pull_request",
      conclusion: "success",
      attempt: 1,
      createdAt: "2026-09-10T23:59:14Z",
    },
  ],
  reviews: [
    {
      author: REVIEWER,
      state: "commented",
      submittedAt: "2026-09-11T00:05:15Z",
      body: "Changes requested: one bug.\n- [blocking] F1 a.ts — the bug",
    },
    { author: REVIEWER, state: "commented", submittedAt: "2026-09-11T00:17:46Z", body: "LGTM: fixed." },
  ],
  pushes: [
    { actor: "alice", at: "2026-09-11T00:13:41Z", kind: "force", coauthors: ["Claude <noreply@anthropic.com>"] },
  ],
  ...over,
});

/** A finished review run of the repository that named the pull request in its label. */
const reviewRun = (id: string, prNumber: number, repo = "acme/api"): RunRecord => ({
  id,
  label: `review · ${repo} · "review https://github.com/${repo}/pull/${prNumber}"`,
  agent: "review",
  channelId: "slack:C1",
  userId: "slack:UALICE",
  threadKey: "slack:C1:t1",
  // Private: readable by a member of the channel or an all-channels holder, never by every viewer.
  channelVisibility: "private",
  repo,
  startedAt: NOW - 3_600_000,
  finishedAt: NOW - 3_600_000 + 300_000,
  status: "completed",
  eventCount: 0,
  storedEventCount: 0,
  truncated: false,
  events: [],
  diagnosis: analyzeRunFriction([], { finished: true }),
});

function bound(
  opts: { repos?: string[]; prs?: Record<string, PullRequestFacts[]>; runs?: RunRecord[]; off?: boolean } = {},
) {
  const source = new InMemoryDeliverySource(opts.prs ?? { "acme/api": [pr(917)] });
  const service = opts.off
    ? new NullDeliveryService()
    : createDeliveryService(
        opts.repos
          ? {
              repos: opts.repos,
              reviewers: [],
              agentLogins: [],
              agentCoauthors: ["Claude"],
              snapshot: { everyMinutes: 60 },
            }
          : undefined,
        source,
        { identities: async () => ({ reviewers: [REVIEWER] }), now: () => new Date(NOW) },
      );
  const store = new InMemoryRunStore();
  const puts = (opts.runs ?? []).map((r) => store.put(r));
  const registry = new CommandRegistry<DeliveryCommandDeps>({ audit: () => {} });
  registerDeliveryCommands(registry);
  const deps: DeliveryCommandDeps = {
    delivery: { service: async () => service },
    runs: async () => {
      await Promise.all(puts);
      return createRunsService({ registry: new RunRegistry(), store, clock: () => NOW });
    },
  };
  return { commands: bindCommands(registry, deps), source };
}

describe("delivery.report", () => {
  it("reports the first configured repository over the default range, the caller's own visible runs keyed in", async () => {
    const { commands, source } = bound({
      repos: ["acme/api", "acme/web"],
      runs: [reviewRun("r1", 917), reviewRun("r2", 5, "acme/web")],
    });
    const res = await commands.invoke("delivery.report", {}, operator);
    if (!res.ok) throw new Error(res.message);
    const report = res.value as { repo: string; range: { weeks: number }; totals: Record<string, unknown> };
    expect(report.repo).toBe("acme/api");
    expect(report.range.weeks).toBe(4);
    expect(report.totals).toMatchObject({
      prsMerged: 1,
      reviewRounds: { verdicts: 2, fixRounds: 1, reviewed: 1, perPr: 2 },
      findings: { total: 1, blocking: 1, noHumanEdit: 1, noHumanEditShare: 1 },
      // The run of the other repository adds nothing here.
      agentRuns: { count: 1, minutes: 5 },
    });
    expect(source.calls).toEqual([{ repo: "acme/api", range: expect.objectContaining({ weeks: 4 }) }]);
    const text = renderText(commands.get("delivery.report")!, res.value);
    expect(text).toContain("acme/api ·");
    expect(text).toContain("1 merged (0 agent-authored)");
    expect(text).toContain("findings: 1 (1 blocking) · 100% resolved with no human edit");
    expect(text).not.toMatch(/\S {2,}\S/);
  });

  it("the report says when its facts were read; `--fresh` asks the service for a live read", async () => {
    const { commands, source } = bound({ repos: ["acme/api"] });
    const stored = await commands.invoke("delivery.report", {}, operator);
    if (!stored.ok) throw new Error(stored.message);
    expect((stored.value as { snapshotAt: string }).snapshotAt).toBe(new Date(NOW).toISOString());
    expect(renderText(commands.get("delivery.report")!, stored.value)).toMatch(/· as of \S+ \d\d:\d\d UTC, /);
    const fresh = await commands.invoke("delivery.report", { options: { fresh: true } }, operator);
    if (!fresh.ok) throw new Error(fresh.message);
    expect(source.calls.map((c) => c.fresh)).toEqual([undefined, true]);
  });

  it("`--repo` names any repository, `--weeks` and `--since` set the range; a caller who may read no runs gets the pull requests alone", async () => {
    const { commands, source } = bound({
      repos: ["acme/api"],
      prs: { "acme/web": [pr(3)] },
      runs: [reviewRun("r1", 3, "acme/web")],
    });
    const byWeeks = await commands.invoke("delivery.report", { options: { repo: "acme/web", weeks: 2 } }, noRuns);
    if (!byWeeks.ok) throw new Error(byWeeks.message);
    expect((byWeeks.value as { repo: string; range: { weeks: number } }).repo).toBe("acme/web");
    expect((byWeeks.value as { range: { weeks: number } }).range.weeks).toBe(2);
    expect((byWeeks.value as { totals: { agentRuns: { count: number } } }).totals.agentRuns.count).toBe(0);
    const bySince = await commands.invoke(
      "delivery.report",
      { options: { repo: "acme/web", since: "2026-09-01T00:00:00Z".slice(0, 10) } },
      noRuns,
    );
    if (!bySince.ok) throw new Error(bySince.message);
    expect((bySince.value as { range: { since: string } }).range.since).toBe("2026-09-01T00:00:00Z".slice(0, 10));
    expect(source.calls.map((c) => c.repo)).toEqual(["acme/web", "acme/web"]);
  });

  it("`--since` decides the range when both are given; a malformed repository is refused, and so is the bare form with no repository configured", async () => {
    const { commands } = bound();
    const both = await commands.invoke(
      "delivery.report",
      { options: { repo: "acme/api", since: "2026-09-01T00:00:00Z".slice(0, 10), weeks: 2 } },
      operator,
    );
    if (!both.ok) throw new Error(both.message);
    expect((both.value as { range: { since: string; weeks: number } }).range).toMatchObject({
      since: "2026-09-01T00:00:00Z".slice(0, 10),
      weeks: 2, // the two Monday-start weeks that day and today fall in — from the date, not the flag
    });
    const bad = await commands.invoke("delivery.report", { options: { repo: "not a slug" } }, operator);
    expect(bad).toMatchObject({ ok: false, error: "invalid_input" });
    const bare = await commands.invoke("delivery.report", {}, operator);
    expect(bare).toMatchObject({ ok: false, error: "invalid_input" });
    if (!bare.ok) expect(bare.message).toMatch(/--repo owner\/name/);
  });

  it("a process without GitHub answers `unavailable` with the reason (the command is hidden there anyway: it needs the github capability)", async () => {
    const { commands } = bound({ off: true });
    const res = await commands.invoke("delivery.report", { options: { repo: "acme/api" } }, operator);
    expect(res).toMatchObject({ ok: false, error: "unavailable" });
    if (!res.ok) expect(res.message).toMatch(/GitHub credential/);
    expect(deliveryReport.enabledWhen?.(ALL_CAPABILITIES)).toBe(true);
    expect(deliveryReport.enabledWhen?.(NO_CAPABILITIES)).toBe(false);
    expect(deliveryReport.enabledWhen?.({ ...NO_CAPABILITIES, github: true })).toBe(true);
  });

  it("an upstream failure is `unavailable` too, never a 500-shaped throw", async () => {
    const failing = createDeliveryService(
      undefined,
      {
        fetchPullRequests: () => Promise.reject(new Error("GitHub GET pulls failed: HTTP 502 bad gateway")),
      },
      { now: () => new Date(NOW) },
    );
    const registry = new CommandRegistry<DeliveryCommandDeps>({ audit: () => {} });
    registerDeliveryCommands(registry);
    const commands = bindCommands(registry, {
      delivery: { service: async () => failing },
      runs: async () => createRunsService({ registry: new RunRegistry(), store: null, clock: () => NOW }),
    });
    const res = await commands.invoke("delivery.report", { options: { repo: "acme/api" } }, operator);
    expect(res).toMatchObject({ ok: false, error: "unavailable" });
    if (!res.ok) expect(res.message).toContain("HTTP 502");
  });

  it("is a read on every surface under `delivery:read`, gated on the github capability", () => {
    expect(deliveryReport).toMatchObject({ id: "delivery.report", action: "delivery:read", effect: "read" });
    expect(deliveryReport.surfaces).toBeUndefined();
  });
});
