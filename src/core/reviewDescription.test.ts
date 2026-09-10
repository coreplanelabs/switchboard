import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePrDescription, renderPrDescriptionMarkdown } from "./prDescription.js";
import { PR_BODY_CAP } from "./repoContext.js";
import {
  findSubmittedPrDescription,
  parsedPrDescriptionArtifact,
  startReviewDescription,
  submittedPrDescriptionArtifact,
  SUBMITTED_LOOKUP_LIMIT,
} from "./reviewDescription.js";
import { analyzeRunFriction } from "./runFriction.js";
import type { RunRecord } from "./runRecord.js";
import type { PrDescriptionArtifact, RunEvent } from "./runEvents.js";
import { InMemoryRunStore, NullRunStore, type RunStore } from "./runStore.js";

// Feature: docs/reference/specs/reading-diff.md item 7 — the PR's description as data on
// the run stream. The `submitted` builder turns the typed object a coding run
// submitted into the artifact the post-step publishes beside `pr_opened`:
// exact and complete, every anchor stamped with the head the body was
// rendered at, every string leaf sanitized like the reading diff.

const HEAD = "685c471f31feaadd725fb917b68a2eea31c0f81a";
const golden = () =>
  parsePrDescription(
    JSON.parse(readFileSync(new URL("./testing/goldenTour.description.json", import.meta.url), "utf8")),
  );

describe("submittedPrDescriptionArtifact", () => {
  it("carries the golden's title, tldr, tour (anchors stamped with the render sha), remaining and decisions plus the rendered body; complete, no problems, not truncated", () => {
    const desc = golden();
    const body = renderPrDescriptionMarkdown(desc, { repo: "acme/api", headSha: HEAD });
    const a = submittedPrDescriptionArtifact(desc, { repo: "acme/api", pr: 329, headSha: HEAD, body });
    expect(a).toEqual({
      artifact: "pr_description",
      origin: "submitted",
      repo: "acme/api",
      pr: 329,
      headSha: HEAD,
      title: desc.title,
      body,
      tldr: desc.tldr,
      tour: desc.tour.map((s) => ({ ...s, anchor: { ...s.anchor, sha: HEAD } })),
      remaining: desc.remaining,
      decisions: desc.decisions,
      complete: true,
      problems: [],
      truncated: false,
    });
  });

  it("every string leaf is control-stripped and redacted — the title, a step's prose, an anchor path, a decision and the body alike; numbers ride unchanged", () => {
    const token = `ghp_${"a".repeat(30)}`;
    const desc = {
      ...golden(),
      title: `Rotate ${token}`,
      tour: [
        {
          title: "The fix",
          description: `\u001b[32mgreen\u001b[0m uses ${token}`,
          anchor: { path: `src/${token}.ts`, from: 1, to: 2 },
        },
      ],
      decisions: [{ title: "Keep it", rationale: `Authorization: Bearer ${token}` }],
    };
    const body = renderPrDescriptionMarkdown(desc, { repo: "acme/api", headSha: HEAD });
    const a = submittedPrDescriptionArtifact(desc, { repo: "acme/api", pr: 1, headSha: HEAD, body });
    const json = JSON.stringify(a);
    expect(json).not.toContain(token);
    expect(json).not.toContain("\u001b");
    expect(a.title).toBe("Rotate «redacted-github-token»");
    expect(a.tour[0].description).toBe("green uses «redacted-github-token»");
    expect(a.tour[0].anchor).toEqual({ path: "src/«redacted-github-token».ts", from: 1, to: 2, sha: HEAD });
    expect(a.decisions[0].rationale).toContain("«redacted»");
    expect(a.body).toContain("«redacted-github-token»");
  });
});

describe("parsedPrDescriptionArtifact", () => {
  it("the golden body parses back complete: title from the facts, tldr and tour from the body, the reviewed head beside the anchors' render sha", () => {
    const desc = golden();
    const body = renderPrDescriptionMarkdown(desc, { repo: "acme/api", headSha: HEAD });
    const reviewed = "f".repeat(40); // reviewing a later head than the anchors were rendered at
    const a = parsedPrDescriptionArtifact(
      { title: "The PR title", body, truncated: false },
      { repo: "acme/api", pr: 329, headSha: reviewed },
    );
    expect(a).toMatchObject({
      artifact: "pr_description",
      origin: "parsed",
      repo: "acme/api",
      pr: 329,
      headSha: reviewed,
      title: "The PR title",
      body,
      tldr: desc.tldr,
      remaining: desc.remaining,
      decisions: desc.decisions,
      complete: true,
      problems: [],
      truncated: false,
    });
    expect(a.tour).toEqual(desc.tour.map((s) => ({ ...s, anchor: { ...s.anchor, sha: HEAD } })));
    expect(a.tour.every((s) => s.anchor.sha !== a.headSha)).toBe(true); // the panel can tell they differ
  });

  it("sanitizes BEFORE parsing — a token in the body never reaches tldr, a step or the body; ANSI is stripped", () => {
    const token = `ghp_${"b".repeat(30)}`;
    const body = [
      "## TL;DR",
      "",
      `Rotate \u001b[31m${token}\u001b[0m now.`,
      "",
      "## Tour",
      "",
      "### 1. The key",
      "",
      `It was ${token}.`,
      "",
      `https://github.com/acme/api/blob/${HEAD}/src/a.ts#L1-L2`,
      "",
      "### 2. Remaining changes",
      "",
      "- none — every touched file is covered by a step above",
    ].join("\n");
    const a = parsedPrDescriptionArtifact({ title: `t ${token}`, body, truncated: false }, { repo: "acme/api", pr: 1 });
    expect(JSON.stringify(a)).not.toContain(token);
    expect(JSON.stringify(a)).not.toContain("\u001b");
    expect(a.tldr).toBe("Rotate «redacted-github-token» now.");
    expect(a.tour[0].description).toBe("It was «redacted-github-token».");
    expect(a.title).toBe("t «redacted-github-token»");
    expect(a.headSha).toBeUndefined();
  });

  it("a body without the shape: tldr from the first paragraph, empty tour, complete false; a truncated body names the cut as the first problem", () => {
    const plain = parsedPrDescriptionArtifact(
      { title: "t", body: "Just prose.", truncated: false },
      { repo: "acme/api", pr: 1 },
    );
    expect(plain).toMatchObject({ tldr: "Just prose.", tour: [], remaining: [], decisions: [], complete: false });
    const cut = parsedPrDescriptionArtifact(
      { title: "t", body: "Just prose.", truncated: true },
      { repo: "acme/api", pr: 1 },
    );
    expect(cut.truncated).toBe(true);
    expect(cut.complete).toBe(false);
    expect(cut.problems[0]).toBe(`body truncated at ${PR_BODY_CAP} chars before parsing`);
    const empty = parsedPrDescriptionArtifact({ title: "t", body: "", truncated: false }, { repo: "acme/api", pr: 1 });
    expect(empty.tldr).toBeUndefined();
    expect(empty.complete).toBe(false);
  });
});

// The store lookup and the dispatcher's one call. Records are built like the
// store's own tests build them; only the events matter here.
const NOW = Date.now() - 60_000; // inside retention, never the publish instant
function record(id: string, finishedAt: number, events: RunEvent[], over: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    agent: "coding",
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey: `slack:C1:${id}`,
    channelVisibility: "public",
    repo: "acme/api",
    startedAt: finishedAt - 5000,
    finishedAt,
    status: "completed",
    eventCount: events.length,
    storedEventCount: events.length,
    truncated: false,
    events: events.map((e, i) => ({ ...e, seq: i + 1 })),
    diagnosis: analyzeRunFriction(events),
    ...over,
  };
}
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
function submitted(over: Partial<PrDescriptionArtifact> = {}): RunEvent {
  return {
    type: "review_artifact",
    artifact: "pr_description",
    origin: "submitted",
    repo: "acme/api",
    pr: 42,
    headSha: SHA_A,
    title: "Fix the gate",
    body: "## TL;DR\n\nx",
    tldr: "x",
    tour: [{ title: "s", description: "d", anchor: { path: "src/a.ts", from: 1, to: 2, sha: SHA_A } }],
    remaining: [],
    decisions: [],
    complete: true,
    problems: [],
    truncated: false,
    at: NOW,
    ...over,
  };
}
const FACTS = { title: "Fix the gate (GitHub's title)", body: "## TL;DR\n\nfrom the body", truncated: false };

describe("findSubmittedPrDescription", () => {
  it("finds the newest submitted artifact for exactly this repo, PR and head — skipping parsed copies, other PRs, other heads and other repos", async () => {
    const store = new InMemoryRunStore();
    await store.put(record("old-match", NOW - 40_000, [submitted({ title: "older" })]));
    await store.put(record("other-pr", NOW - 30_000, [submitted({ pr: 43 })]));
    await store.put(record("other-head", NOW - 20_000, [submitted({ headSha: SHA_B })]));
    await store.put(record("parsed-only", NOW - 15_000, [submitted({ origin: "parsed" })]));
    await store.put(record("other-repo", NOW - 5_000, [submitted({ repo: "acme/web" })], { repo: "acme/web" }));
    await store.put(record("new-match", NOW - 10_000, [submitted({ title: "newer" })]));
    const found = await findSubmittedPrDescription(store, { repo: "acme/api", pr: 42, headSha: SHA_A });
    expect(found?.runId).toBe("new-match");
    expect(found?.artifact.title).toBe("newer");
    expect(found?.artifact.fromRunId).toBe("new-match");
    expect("type" in (found?.artifact ?? {})).toBe(false); // the envelope is stripped
    // the other-head record IS the match for a review at SHA_B; a head nobody submitted for finds nothing
    expect(await findSubmittedPrDescription(store, { repo: "acme/api", pr: 42, headSha: SHA_B })).toMatchObject({
      runId: "other-head",
    });
    expect(
      await findSubmittedPrDescription(store, { repo: "acme/api", pr: 42, headSha: "c".repeat(40) }),
    ).toBeUndefined();
    expect(await findSubmittedPrDescription(store, { repo: "acme/api", pr: 7, headSha: SHA_A })).toBeUndefined();
  });

  it("a review run's copy counts and keeps the coding run as fromRunId; the newest artifact within a record wins; the read is bounded by the limit", async () => {
    const store = new InMemoryRunStore();
    await store.put(
      record("coding", NOW - 20_000, [submitted({ title: "first push" }), submitted({ title: "resubmitted" })]),
    );
    await store.put(
      record("review", NOW - 10_000, [submitted({ title: "resubmitted", fromRunId: "coding" })], { agent: "review" }),
    );
    const found = await findSubmittedPrDescription(store, { repo: "acme/api", pr: 42, headSha: SHA_A });
    expect(found).toMatchObject({ runId: "review", artifact: { title: "resubmitted", fromRunId: "coding" } });
    // Bound: the match sits behind `limit` newer records → not found.
    const busy = new InMemoryRunStore();
    await busy.put(record("match", NOW - 100_000, [submitted()]));
    for (let i = 0; i < SUBMITTED_LOOKUP_LIMIT; i++) busy.put(record(`noise-${i}`, NOW - i * 1000, []));
    expect(await findSubmittedPrDescription(busy, { repo: "acme/api", pr: 42, headSha: SHA_A })).toBeUndefined();
    expect(
      await findSubmittedPrDescription(busy, { repo: "acme/api", pr: 42, headSha: SHA_A }, SUBMITTED_LOOKUP_LIMIT + 1),
    ).toMatchObject({ runId: "match" });
  });
});

describe("startReviewDescription", () => {
  const publishInto = (events: RunEvent[]) => (e: RunEvent) => void events.push(e);

  it("prefers the submitted object the store holds for the reviewed head: published once, re-stamped, fromRunId naming the coding run — the facts' title is not used", async () => {
    const store = new InMemoryRunStore();
    await store.put(record("coding", NOW - 10_000, [submitted()]));
    const events: RunEvent[] = [];
    const ok = await startReviewDescription({
      store,
      repoCtx: { repo: "acme/api", pr: 42, headSha: SHA_A, prDescription: FACTS },
      publish: publishInto(events),
    });
    expect(ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "review_artifact",
      artifact: "pr_description",
      origin: "submitted",
      fromRunId: "coding",
      title: "Fix the gate",
      at: expect.any(Number),
    });
    expect((events[0] as { at: number }).at).not.toBe(NOW);
  });

  it("no submitted object for this head (none stored, another head, or a store that throws) → the body is parsed", async () => {
    const cases: RunStore[] = [new NullRunStore()];
    const otherHead = new InMemoryRunStore();
    await otherHead.put(record("coding", NOW - 10_000, [submitted({ headSha: SHA_B })]));
    cases.push(otherHead);
    const throwing = new NullRunStore();
    throwing.list = async () => {
      throw new Error("store down");
    };
    cases.push(throwing);
    for (const store of cases) {
      const events: RunEvent[] = [];
      const ok = await startReviewDescription({
        store,
        repoCtx: { repo: "acme/api", pr: 42, headSha: SHA_A, prDescription: FACTS },
        publish: publishInto(events),
      });
      expect(ok).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ origin: "parsed", title: FACTS.title, tldr: "from the body", headSha: SHA_A });
    }
  });

  it("no PR, or a PR without facts and no stored object → nothing published, resolves false, never rejects", async () => {
    const events: RunEvent[] = [];
    const store = new NullRunStore();
    expect(await startReviewDescription({ store, repoCtx: { repo: "acme/api" }, publish: publishInto(events) })).toBe(
      false,
    );
    expect(
      await startReviewDescription({ store, repoCtx: { repo: "acme/api", pr: 42 }, publish: publishInto(events) }),
    ).toBe(false);
    // Facts present but no head (the fetch gave a malformed sha): the store is not asked; the body is parsed
    const parsedOnly = await startReviewDescription({
      store,
      repoCtx: { repo: "acme/api", pr: 42, prDescription: FACTS },
      publish: publishInto(events),
    });
    expect(parsedOnly).toBe(true);
    expect(events).toHaveLength(1);
    expect((events[0] as PrDescriptionArtifact).headSha).toBeUndefined();
    // A publish that throws is contained
    const boom = await startReviewDescription({
      store,
      repoCtx: { repo: "acme/api", pr: 42, prDescription: FACTS },
      publish: () => {
        throw new Error("registry closed");
      },
    });
    expect(boom).toBe(false);
  });
});
