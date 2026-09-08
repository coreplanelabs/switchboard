import { createServer } from "node:http";
import { join } from "node:path";
import { loadWebAssets } from "../src/channels/webAssets.js";
import { makeShellRenderer, WEB_HTML_HEADERS } from "../src/channels/webShell.js";
import type { PageSeed, RunIndexRowSeed } from "../src/channels/webSeed.js";
import { ALL_CAPABILITIES, NO_CAPABILITIES } from "../src/core/capabilities.js";
import type { CostReport, DailyCost } from "../src/core/costs.js";
import { FAVICON_ICO_SVG } from "../src/channels/favicon.js";
import { isRunSchedule, SCHEDULES } from "../src/core/schedules.js";
import { normalizeSpans } from "../src/core/normalizeSpans.js";
import type { RunEvent } from "../src/core/runEvents.js";
import { systemClock } from "../src/core/trace/clock.js";
import { READING_DIFF_GIT, READING_DIFF_MEAT, READING_DIFF_SUMMARY } from "./web-preview-reading-diff.js";

// Local visual preview of the web app (web/) with fixture data — no Slack, no
// config.yaml, no credentials. Build the app first (`npm run build` in web/),
// then `npx tsx scripts/web-preview.ts` and open http://localhost:8788/runs.
//
//   /runs            index with a mixed set of rows       /runs?all=1  incl. finished
//   /runs/live-1     a live run fed by a scripted SSE stream (loops forever)
//   /runs/hist-1     a finished run in history mode        /runs/nope   the 404
//   /runs/review-1   a finished PR review carrying both reading diffs (the panel)
//   /runs/hist-4     a finished PR review with a request_changes verdict as the Reply
//   /runs/scheduled  the Scheduled tab                     /residents   /costs
//
// SWITCHBOARD_PREVIEW_CAPABILITIES=minimal serves the same fixtures with every
// optional capability off (the nav shrinks to Runs, no Scheduled tab, no docs).
// SWITCHBOARD_PREVIEW_NOW=<epoch ms> holds the fixtures' clock still, so two
// renders of one tree agree (scripts/screenshots.mts).

const PORT = Number(process.env.PORT ?? 8788);
const NOW = process.env.SWITCHBOARD_PREVIEW_NOW ? Number(process.env.SWITCHBOARD_PREVIEW_NOW) : systemClock();

const assets = loadWebAssets(process.env.SWITCHBOARD_WEB_DIST ?? join(process.cwd(), "web", "dist"));
// The shell stamps the capabilities the nav paints from: every one on by
// default (every surface reachable); SWITCHBOARD_PREVIEW_CAPABILITIES=minimal
// paints the smallest installation instead — Runs alone, no Scheduled tab, no
// docs link — so both shapes of the header can be seen and screenshotted.
const CAPABILITIES = process.env.SWITCHBOARD_PREVIEW_CAPABILITIES === "minimal" ? NO_CAPABILITIES : ALL_CAPABILITIES;
const shell = makeShellRenderer(assets.entry, CAPABILITIES);

const row = (over: Partial<RunIndexRowSeed>): RunIndexRowSeed => ({
  id: "run-x",
  label: 'coding · acme/web · "fix the build"',
  channelId: "slack:C1",
  userId: "slack:UALICE",
  finished: false,
  startedAt: NOW - 252_000,
  eventCount: 17,
  ...over,
});

const INDEX_ROWS: RunIndexRowSeed[] = [
  row({
    id: "live-1",
    token: "tok-live-1",
    label: 'review · acme/api · "re-review after the repush"',
    activity: "$ npm test",
    userName: "alice",
    sourceUrl: "https://example.slack.com/archives/C1/p1",
    startedAt: NOW - 252_000,
  }),
  row({
    id: "live-2",
    token: "tok-live-2",
    label: 'general · #dev · alice · "what changed in the last deploy?"',
    startedAt: NOW - 61_000,
    eventCount: 3,
  }),
  row({
    id: "hist-1",
    label: 'coding · acme/web · "add retry logic to the webhook sender"',
    finished: true,
    persisted: true,
    startedAt: NOW - 4 * 3_600_000,
    finishedAt: NOW - 4 * 3_600_000 + 754_000,
    status: "completed",
    eventCount: 214,
    channelId: "cli:local",
    userId: "cli:alice",
  }),
  row({
    id: "hist-4",
    label: 'review · acme/api · "please review https://github.com/acme/api/pull/42 — the retry-queue change"',
    finished: true,
    persisted: true,
    startedAt: NOW - 3 * 3_600_000,
    finishedAt: NOW - 3 * 3_600_000 + 252_000,
    status: "completed",
    eventCount: 27,
    userName: "sam",
  }),
  row({
    id: "hist-2",
    label: 'research · #ops · sam · "why did the deploy roll back?"',
    finished: true,
    persisted: true,
    startedAt: NOW - 26 * 3_600_000,
    finishedAt: NOW - 26 * 3_600_000 + 121_000,
    status: "failed",
    activity: "⚠️ resident not onboarded: acme/web",
    eventCount: 41,
    channelId: "http:hooks",
    userId: "http:svc",
  }),
  row({
    id: "review-1",
    label: 'review · acme/api · "review the webhook retry PR"',
    finished: true,
    persisted: true,
    startedAt: NOW - 7 * 3_600_000,
    finishedAt: NOW - 7 * 3_600_000 + 412_000,
    status: "completed",
    eventCount: 19,
    userName: "alice",
  }),
  row({
    id: "hist-3",
    label: 'coding · acme/api · "bump the SDK"',
    finished: true,
    persisted: true,
    startedAt: NOW - 29.6 * 86_400_000,
    finishedAt: NOW - 29.5 * 86_400_000,
    status: "stopped_soft",
    eventCount: 12,
    channelId: "mcp:claude",
    userId: "mcp:alice",
  }),
];

/** One model call as the runner records it (docs/reference/specs/tracing.md): a
 *  `model.turn` span under the agent loop, its stop reason, model and token
 *  usage as attrs; `seq` places it in the replayed stream like every event. */
const modelTurn = (
  spanId: string,
  startedAt: number,
  durationMs: number,
  seq: number,
  attrs: Record<string, string | number>,
) => ({
  type: "span_end",
  spanId,
  parentSpanId: "agent",
  name: "model.turn",
  startedAt,
  durationMs,
  status: "ok",
  attrs,
  at: startedAt + durationMs,
  seq,
});

const HIST_EVENTS = [
  {
    type: "input",
    text: "Add **retry logic** to the webhook sender:\n\n- exponential backoff\n- max 5 attempts\n- give up on 4xx\n\nAcceptance: a 5xx from the receiver retries with growing delays and gives up after the fifth attempt with one `warn` log naming the status; a 4xx never retries; the existing callers in `src/jobs/` keep their signature. Add tests for both paths before the implementation, and keep the change to `src/webhooks.ts` and its test file.",
    at: NOW - 2_400_000,
    seq: 1,
    source: { channel: "dev", user: "alice", url: "https://example.slack.com/archives/C1/p1" },
  },
  { type: "context", text: "earlier: we agreed the sender should never retry a 4xx", at: NOW - 2_400_000, seq: 2 },
  {
    type: "run_meta",
    agent: "coding",
    model: "anthropic/claude-fable-5",
    effort: "high",
    repo: "acme/web",
    ref: "main",
    pr: 42,
    at: NOW - 2_399_000,
    seq: 3,
  },
  modelTurn("m1", NOW - 2_399_000, 9_000, 4, {
    stopReason: "tool_use",
    model: "anthropic/claude-fable-5",
    inputTokens: 12_300,
    outputTokens: 810,
    cacheReadTokens: 11_200,
  }),
  {
    type: "assistant",
    text: "I'll look at the current sender first, then write the failing tests.",
    at: NOW - 2_389_000,
    seq: 5,
  },
  { type: "tool_call", callId: "c1", tool: "bash", summary: "$ rg -n 'sendWebhook' src", at: NOW - 2_388_000, seq: 6 },
  {
    type: "tool_result",
    callId: "c1",
    tool: "bash",
    ok: true,
    summary: "(3 chars, 2 lines)",
    output: "src/webhooks.ts:41:export async function sendWebhook(",
    at: NOW - 2_387_000,
    seq: 7,
  },
  { type: "tool_call", callId: "c2", tool: "bash", summary: "$ npm test -- webhooks", at: NOW - 2_386_000, seq: 8 },
  {
    type: "tool_result",
    callId: "c2",
    tool: "bash",
    ok: false,
    exitCode: 1,
    summary: "(120 chars, 9 lines)",
    output: "FAIL webhooks.test.ts\n  ✗ retries with backoff (new)\n  expected 5 attempts, got 1",
    at: NOW - 2_350_000,
    seq: 9,
  },
  // A thread follow-up steered into the run (docs/reference/specs/thread-admission.md
  // item 2): the `input` + `follow_up` note pair the runner records when it
  // drains the inbox at a step boundary.
  {
    type: "input",
    text: "additional constraints for this change, please fold them in: (1) the `sendWebhook` signature stays as-is — callers in `src/jobs/` must not change; (2) jitter the backoff (±20%) so a burst of failures doesn't retry in lockstep; (3) log each give-up with the status code at `warn`.",
    at: NOW - 2_345_000,
    seq: 10,
    source: { user: "alice", url: "https://example.slack.com/archives/C1/p2" },
  },
  {
    type: "run_note",
    kind: "follow_up",
    summary: "follow-up folded in: additional constraints for this change, please fold them in: (1) the `sendWebho…",
    at: NOW - 2_345_000,
    seq: 11,
  },
  {
    type: "skill_use",
    skill: "http-retries",
    description: "Backoff patterns for flaky endpoints",
    agent: "coding",
    bodyBytes: 2048,
    source: "https://example.com/skills/http-retries",
    at: NOW - 2_340_000,
    seq: 12,
  },
  {
    type: "assistant",
    text: "Tests are red as expected — implementing the backoff now.",
    at: NOW - 2_330_000,
    seq: 13,
  },
  {
    type: "tool_call",
    callId: "c3",
    tool: "update_status",
    summary: "update_status implementing backoff",
    at: NOW - 2_329_000,
    seq: 14,
  },
  { type: "tool_result", callId: "c3", tool: "update_status", ok: true, summary: "", at: NOW - 2_329_000, seq: 15 },
  // The slow middle of the run (item 24): a five-minute think, a typegen the
  // sandbox killed at its 15-minute deadline, and a 3.5-minute type check —
  // the durations that should read warm and over budget on the page.
  modelTurn("m2", NOW - 2_324_000, 304_000, 16, {
    stopReason: "tool_use",
    inputTokens: 48_900,
    outputTokens: 2_100,
    cacheReadTokens: 40_200,
  }),
  { type: "assistant", text: "Regenerating the generated types before the type check.", at: NOW - 2_019_000, seq: 17 },
  { type: "tool_call", callId: "c5", tool: "bash", summary: "$ pnpm typegen", at: NOW - 2_018_000, seq: 18 },
  {
    type: "tool_result",
    callId: "c5",
    tool: "bash",
    ok: false,
    exitCode: 124,
    summary: "(63 chars, 2 lines)",
    output: "generating types for 148 workers…\ncommand timed out after 15m 00s",
    at: NOW - 1_118_000,
    seq: 19,
  },
  { type: "tool_call", callId: "c6", tool: "bash", summary: "$ pnpm tsgo --noEmit", at: NOW - 1_115_000, seq: 20 },
  {
    type: "tool_result",
    callId: "c6",
    tool: "bash",
    ok: true,
    summary: "(0 chars)",
    output: "",
    at: NOW - 901_000,
    seq: 21,
  },
  { type: "tool_call", callId: "c4", tool: "bash", summary: "$ npm test", at: NOW - 800_000, seq: 22 },
  {
    type: "tool_result",
    callId: "c4",
    tool: "bash",
    ok: true,
    summary: "(400 chars, 31 lines)",
    output: "PASS webhooks.test.ts (12 tests)",
    at: NOW - 760_000,
    seq: 23,
  },
  // The answer's own turn, on a DIFFERENT model than the run started on — not
  // something a run does today (it is pinned to one model), but the switch
  // treatment (`⇄ claude-opus-5` on the turn's head) has to be seen somewhere.
  modelTurn("m3", NOW - 760_000, 9_000, 24, { stopReason: "end_turn", model: "anthropic/claude-opus-5" }),
  {
    type: "answer",
    text: "Done — `sendWebhook` now retries with exponential backoff (5 attempts, 4xx gives up immediately). PR updated.",
    at: NOW - 750_000,
    seq: 25,
  },
  // The post-step edited the PR the run was on (docs/reference/specs/pr-description.md
  // item 5): the Reply's caption reads it as the run's PR fact.
  {
    type: "pr_opened",
    url: "https://github.com/acme/web/pull/42",
    number: 42,
    created: false,
    at: NOW - 750_200,
    seq: 26,
  },
];

/** The history run as a traced stream (docs/reference/specs/tracing.md): the request root
 *  and the setup spans ahead of the events, the agent loop around them, the
 *  post step after — and `normalizeSpans` giving the tool pairs their spans,
 *  exactly as the history route does. */
const RECEIVED_AT = NOW - 2_405_000;
const HIST_FINISHED_AT = NOW - 750_000;
const spanEnd = (
  spanId: string,
  name: string,
  startedAt: number,
  endedAt: number,
  parentSpanId: string,
  attrs: Record<string, unknown> = {},
) => ({
  type: "span_end",
  spanId,
  parentSpanId,
  name,
  startedAt,
  durationMs: endedAt - startedAt,
  status: "ok",
  attrs,
  at: endedAt,
});
const HIST_STREAM = normalizeSpans([
  {
    type: "span_start",
    spanId: "root",
    name: "request",
    attrs: { channel: "slack", queuedBeforeMs: 0 },
    at: RECEIVED_AT,
  },
  spanEnd("recv", "slack.receive", RECEIVED_AT, RECEIVED_AT + 1_200, "root"),
  spanEnd("hist", "dispatch.history", RECEIVED_AT + 1_200, RECEIVED_AT + 2_600, "root"),
  spanEnd("attach", "dispatch.workspace.attach", RECEIVED_AT + 2_600, RECEIVED_AT + 4_900, "root", {
    backend: "resident",
  }),
  spanEnd("wait", "dispatch.workspace.attach.mutex_wait", RECEIVED_AT + 2_600, RECEIVED_AT + 2_900, "attach", {
    backend: "resident",
    waitedMs: 300,
  }),
  spanEnd("clone", "dispatch.workspace.attach.clone", RECEIVED_AT + 2_900, RECEIVED_AT + 4_700, "attach", {
    backend: "resident",
    exitCode: 0,
  }),
  spanEnd("compose", "dispatch.compose", RECEIVED_AT + 4_900, RECEIVED_AT + 5_000, "root"),
  { type: "span_start", spanId: "agent", parentSpanId: "root", name: "run.agent", at: NOW - 2_399_000 },
  ...HIST_EVENTS,
  spanEnd("agent", "run.agent", NOW - 2_399_000, NOW - 750_500, "root"),
  spanEnd("post", "run.pr_post_step", NOW - 750_500, HIST_FINISHED_AT, "root"),
] as RunEvent[]);

// A finished PR review: the same stream shape, plus the two `review_artifact`
// events the run-page panel renders (docs/reference/specs/reading-diff.md item 12) — git's
// full diff (capped, so the truncation badge shows) and meat's abridged one.
const REVIEW_RECEIVED_AT = NOW - 7 * 3_600_000;
const REVIEW_FINISHED_AT = REVIEW_RECEIVED_AT + 412_000;
const REVIEW_STREAM = normalizeSpans([
  {
    type: "span_start",
    spanId: "root",
    name: "request",
    attrs: { channel: "slack", queuedBeforeMs: 0 },
    at: REVIEW_RECEIVED_AT,
  },
  spanEnd("recv", "slack.receive", REVIEW_RECEIVED_AT, REVIEW_RECEIVED_AT + 900, "root"),
  spanEnd("hist", "dispatch.history", REVIEW_RECEIVED_AT + 900, REVIEW_RECEIVED_AT + 1_000, "root"),
  {
    type: "input",
    text: "review https://github.com/acme/api/pull/57",
    at: REVIEW_RECEIVED_AT,
    seq: 1,
    source: { channel: "dev", user: "alice", url: "https://example.slack.com/archives/C1/p2" },
  },
  {
    type: "run_meta",
    agent: "review",
    model: "anthropic/claude-fable-5",
    effort: "high",
    repo: "acme/api",
    ref: "webhook-retries",
    pr: 57,
    headSha: "9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
    at: REVIEW_RECEIVED_AT + 1_000,
    seq: 2,
  },
  spanEnd("attach", "dispatch.workspace.attach", REVIEW_RECEIVED_AT + 1_000, REVIEW_RECEIVED_AT + 3_800, "root", {
    backend: "resident",
  }),
  { type: "span_start", spanId: "agent", parentSpanId: "root", name: "run.agent", at: REVIEW_RECEIVED_AT + 3_800 },
  modelTurn("r1", REVIEW_RECEIVED_AT + 3_800, 14_000, 3, {
    stopReason: "tool_use",
    model: "anthropic/claude-fable-5",
    inputTokens: 18_400,
    outputTokens: 620,
  }),
  {
    type: "review_artifact",
    artifact: "reading_diff",
    poweredBy: "git",
    baseRef: "main",
    diff: READING_DIFF_GIT,
    truncated: true,
    at: REVIEW_RECEIVED_AT + 6_000,
    seq: 4,
  },
  // The PR's description as data (docs/reference/specs/reading-diff.md item 7), read back
  // from the PR body: its title names the panel, the TL;DR and the What & why
  // open the left column, the Tour's steps jump the diff. The steps cover every
  // placement the panel draws: two the abridged diff keeps, one only the full
  // diff carries (the sender's tests), one anchored at the previous push (the
  // stale badge), one past the cut of the capped full diff (a GitHub link).
  {
    type: "review_artifact",
    artifact: "pr_description",
    origin: "parsed",
    repo: "acme/api",
    pr: 57,
    headSha: "9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
    title: "Webhook deliveries retry with exponential backoff, never on a 4xx",
    body: [
      "## TL;DR",
      "",
      "Webhook deliveries are tried once today; a flaky receiver loses the event. This adds a bounded retry policy and removes the unsigned legacy sender.",
      "",
      "## What & why",
      "",
      "A receiver that is down for a minute drops every event sent in that minute, and the queue never tries again. The sender now walks a backoff schedule — 500 ms doubling to a 30 s cap, five attempts — and stops early on any 4xx, because the receiver saying no is final. The policy is configurable under `webhooks.retry`; retries are counted so a noisy receiver shows up on the dashboard.",
      "",
      "The unsigned legacy sender had no callers left and no signature; it goes in the same change so the retry loop has one path to cover.",
      "",
      "## Tour",
      "",
      "### 1. The retry loop",
    ].join("\n"),
    tldr: "Webhook deliveries are tried once today; a flaky receiver loses the event. This adds a bounded retry policy and removes the unsigned legacy sender.",
    tour: [
      {
        title: "The retry loop",
        description:
          "sendWebhook walks the backoff schedule: the first attempt is immediate, every later one waits its delay; a 4xx returns at once, anything else counts a retry.",
        lookFor: "the early return on a 4xx — it must come before the retry counter",
        anchor: { path: "src/webhooks/sender.ts", from: 31, to: 40, sha: "9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d" },
      },
      {
        title: "The backoff schedule",
        description:
          "backoffDelays doubles from the base delay and caps each step; isRetryable names what is worth another try.",
        anchor: { path: "src/webhooks/retry.ts", from: 1, to: 7, sha: "9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d" },
      },
      {
        title: "The tests pin the two rules",
        description: "A 503 is retried up to the policy and then given up on; a 404 is never retried.",
        lookFor: "the attempts count on the 503 case equals maxAttempts",
        anchor: {
          path: "src/webhooks/sender.test.ts",
          from: 27,
          to: 42,
          sha: "9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
        },
      },
      {
        title: "The policy is config",
        description: "webhooks.retry with defaults, so an existing config keeps working.",
        anchor: { path: "src/config/schema.ts", from: 60, to: 66, sha: "4b7e1c9d2f3a8e5b6c0d1e2f3a4b5c6d7e8f9a0b" },
      },
      {
        title: "The runbook",
        description: "How to read the retry counter and when to raise the cap.",
        anchor: {
          path: "docs/how-to/webhook-retries.md",
          from: 1,
          to: 12,
          sha: "9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
        },
      },
    ],
    remaining: [
      { path: "src/webhooks/legacySender.ts", note: "deleted; no callers" },
      { path: "src/metrics/counters.ts", note: "the retry counter" },
      { path: "CHANGELOG.md", note: "the Unreleased entry" },
    ],
    decisions: [],
    complete: false,
    problems: ["no Decisions section in the body", "no Validation section in the body"],
    truncated: false,
    at: REVIEW_RECEIVED_AT + 6_500,
    seq: 5,
  },
  {
    type: "assistant",
    text: "Reading the sender change first, then the tests.",
    at: REVIEW_RECEIVED_AT + 18_000,
    seq: 6,
  },
  {
    type: "tool_call",
    callId: "r-c1",
    tool: "bash",
    summary: "$ git diff --stat origin/main...HEAD",
    at: REVIEW_RECEIVED_AT + 18_500,
    seq: 7,
  },
  {
    type: "tool_result",
    callId: "r-c1",
    tool: "bash",
    ok: true,
    summary: " 19 files changed, 214 insertions(+), 31 deletions(-)",
    output: " 19 files changed, 214 insertions(+), 31 deletions(-)",
    durationMs: 140,
    at: REVIEW_RECEIVED_AT + 18_700,
    seq: 8,
  },
  {
    type: "review_artifact",
    artifact: "reading_diff",
    poweredBy: "meat",
    baseRef: "main",
    diff: READING_DIFF_MEAT,
    truncated: false,
    summary: READING_DIFF_SUMMARY,
    meatTokens: { input: 21_300, output: 2_900 },
    at: REVIEW_RECEIVED_AT + 96_000,
    seq: 9,
  },
  modelTurn("r2", REVIEW_RECEIVED_AT + 19_000, 380_000, 10, {
    stopReason: "end_turn",
    model: "anthropic/claude-fable-5",
    inputTokens: 41_200,
    outputTokens: 1_900,
  }),
  {
    type: "answer",
    text: "**LGTM:** the retry loop is bounded by the policy, a 4xx is final, and both paths are tested. One nit: `sleep` could live in `retry.ts` beside the delays it waits on.",
    at: REVIEW_RECEIVED_AT + 400_000,
    seq: 11,
  },
  spanEnd("agent", "run.agent", REVIEW_RECEIVED_AT + 3_800, REVIEW_RECEIVED_AT + 400_500, "root"),
  // The finishing-up step the bar counts (docs/reference/specs/tracing.md), then the two
  // delivery spans after the finish stamp — the streamed names, so every row
  // on the page has a display name and the Finishing up head has a step.
  spanEnd("observe", "run.observe_workspace", REVIEW_RECEIVED_AT + 400_500, REVIEW_FINISHED_AT, "root"),
  spanEnd("close", "post.card_close", REVIEW_FINISHED_AT, REVIEW_FINISHED_AT + 400, "root"),
  spanEnd("reply", "post.reply", REVIEW_FINISHED_AT + 400, REVIEW_FINISHED_AT + 1_400, "root"),
] as RunEvent[]);

/** A finished PR review (`/runs/hist-4`): the REVIEW row with the branch, head
 *  and PR links and the Reading diff control, a reading-diff artifact, the
 *  verdict as the Reply, and every phase of the bar present. Three hours old. */
const VERDICT_RECEIVED_AT = NOW - 3 * 3_600_000;
const V = (offsetMs: number) => VERDICT_RECEIVED_AT + offsetMs;
const VERDICT_FINISHED_AT = V(252_000);
const VERDICT_HEAD = "9f2c1a7e4b0d5c6f8a1b2c3d4e5f60718293a4b5";
const VERDICT_EVENTS = [
  {
    type: "input",
    text: "please review https://github.com/acme/api/pull/42 — the retry-queue change; the backoff cap is the part I'm least sure about",
    at: V(1_500),
    seq: 1,
    source: { channel: "api-reviews", user: "sam", url: "https://example.slack.com/archives/C2/p1" },
  },
  {
    type: "run_meta",
    agent: "review",
    model: "anthropic/claude-fable-5",
    effort: "medium",
    repo: "acme/api",
    ref: "feat/retry-queue",
    pr: 42,
    headSha: VERDICT_HEAD,
    at: V(1_600),
    seq: 2,
  },
  {
    type: "review_artifact",
    artifact: "reading_diff",
    poweredBy: "git",
    baseRef: "main",
    diff: "diff --git a/src/queue.ts b/src/queue.ts\n--- a/src/queue.ts\n+++ b/src/queue.ts\n@@ -40,7 +40,9 @@ export function nextDelay(attempt: number): number {\n-  return BASE_MS * 2 ** attempt;\n+  const raw = BASE_MS * 2 ** attempt;\n+  // cap the backoff so a long outage does not park a job for hours\n+  return Math.min(raw, MAX_DELAY_MS);\n }\n",
    truncated: false,
    at: V(20_000),
    seq: 3,
  },
  modelTurn("r1", V(34_000), 36_000, 4, {
    stopReason: "tool_use",
    model: "anthropic/claude-fable-5",
    inputTokens: 21_400,
    outputTokens: 640,
    cacheReadTokens: 18_000,
  }),
  {
    type: "assistant",
    text: "Reading the whole diff and the changed files once, then the callers of `nextDelay`.",
    at: V(70_000),
    seq: 5,
  },
  {
    type: "tool_call",
    callId: "rc1",
    tool: "bash",
    summary: "$ git diff origin/main...HEAD --stat",
    at: V(70_500),
    seq: 6,
  },
  {
    type: "tool_result",
    callId: "rc1",
    tool: "bash",
    ok: true,
    summary: "(96 chars, 3 lines)",
    output:
      " src/queue.ts       | 4 +++-\n src/queue.test.ts  | 12 ++++++++++++\n 2 files changed, 15 insertions(+), 1 deletion(-)",
    at: V(72_000),
    seq: 7,
  },
  { type: "tool_call", callId: "rc2", tool: "bash", summary: "$ rg -n 'nextDelay' src", at: V(72_500), seq: 8 },
  {
    type: "tool_result",
    callId: "rc2",
    tool: "bash",
    ok: true,
    summary: "(140 chars, 3 lines)",
    output:
      "src/queue.ts:40:export function nextDelay(attempt: number): number {\nsrc/worker.ts:88:    await sleep(nextDelay(job.attempt));\nsrc/queue.test.ts:12:  expect(nextDelay(9)).toBe(60_000);",
    at: V(100_000),
    seq: 9,
  },
  modelTurn("r2", V(100_000), 100_000, 10, {
    stopReason: "tool_use",
    model: "anthropic/claude-fable-5",
    inputTokens: 26_900,
    outputTokens: 1_450,
    cacheReadTokens: 21_000,
  }),
  {
    type: "assistant",
    text: "One correctness finding: `MAX_DELAY_MS` is applied before the jitter in `worker.ts`, so a capped delay can still exceed the cap by up to 20%. Declaring the verdict.",
    at: V(200_000),
    seq: 11,
  },
  {
    type: "tool_call",
    callId: "rc3",
    tool: "submit_verdict",
    summary: "submit_verdict request_changes",
    at: V(200_500),
    seq: 12,
  },
  {
    type: "tool_result",
    callId: "rc3",
    tool: "submit_verdict",
    ok: true,
    summary: "(16 chars)",
    output: "verdict recorded",
    at: V(201_000),
    seq: 13,
  },
  modelTurn("r3", V(201_000), 39_000, 14, { stopReason: "end_turn", model: "anthropic/claude-fable-5" }),
  {
    type: "answer",
    text: "Changes requested: the backoff cap is applied before the jitter.\n\n**major** · `src/worker.ts:88` — `sleep(nextDelay(job.attempt))` is followed by `± 20%` jitter in `sleep`, so the cap in `nextDelay` is not a cap: attempt 9 can sleep 72 s against `MAX_DELAY_MS = 60_000`. Apply the jitter first, then `Math.min`.\n\n**nit** · `src/queue.test.ts:12` — the new test pins the capped value but not the jittered one; add a case at the cap.",
    at: V(240_000),
    seq: 15,
  },
];
const VERDICT_STREAM = normalizeSpans([
  { type: "span_start", spanId: "rroot", name: "request", attrs: { channel: "slack", queuedBeforeMs: 0 }, at: V(0) },
  spanEnd("rrecv", "slack.receive", V(0), V(2_000), "rroot"),
  spanEnd("rhist", "dispatch.history", V(2_000), V(6_000), "rroot"),
  spanEnd("rrepo", "dispatch.repo_context", V(6_000), V(20_000), "rroot"),
  spanEnd("rattach", "dispatch.workspace.attach", V(22_000), V(34_000), "rroot", { backend: "resident" }),
  spanEnd("rclone", "dispatch.workspace.attach.clone", V(22_000), V(30_000), "rattach", { backend: "resident" }),
  spanEnd("rdiff", "run.reading_diff", V(34_000), V(154_000), "rroot"),
  { type: "span_start", spanId: "ragent", parentSpanId: "rroot", name: "run.agent", at: V(34_000) },
  ...VERDICT_EVENTS,
  spanEnd("ragent", "run.agent", V(34_000), V(240_000), "rroot"),
  spanEnd("robs", "run.observe_workspace", V(240_000), V(248_000), "rroot"),
  spanEnd("rclose", "post.card_close", V(252_000), V(252_400), "rroot"),
  spanEnd("rreply", "post.reply", V(252_400), V(254_000), "rroot"),
] as RunEvent[]);

/** The script's last command — the one the live stream holds out for a while. */
const LAST_CALL_INDEX = HIST_EVENTS.map((e) => e.type).lastIndexOf("tool_call");

/** The live stream: replays the history script slowly, then keeps the run open. */
function serveLiveStream(res: import("node:http").ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
  res.write("retry: 3000\n\n");
  let i = 0;
  let nextAt = systemClock();
  const timer = setInterval(() => {
    if (i >= HIST_EVENTS.length - 1) {
      res.write(": hb\n\n"); // the answer is held back so the run stays visibly live
      return;
    }
    if (systemClock() < nextAt) return;
    const e = { ...HIST_EVENTS[i], at: systemClock() };
    res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    i++;
    // The last command stays out for half a minute so a ticking running card
    // can be seen; then the model "thinks" forever (the pending-turn row).
    nextAt = systemClock() + (i === LAST_CALL_INDEX + 1 ? 30_000 : 1500);
  }, 500);
  res.on("close", () => clearInterval(timer));
}

const RESIDENTS = {
  cap: 6,
  count: 2,
  residents: [
    {
      resource: "repo:acme/web",
      commands: { install: "npm ci", build: "npm run build", test: "npm test" },
      effects: { test: "readonly" },
      defaultRef: "main",
      provisioningTimeoutMs: 900000,
      worktreeTtlDays: 7,
      onboardedAt: "2026-08-26T01:02:03.000Z",
      updatedAt: "2026-08-26T01:02:03.000Z",
      live: {
        state: "warm",
        reason: "",
        sha: "0123456789abcdef0123456789abcdef01234567",
        lockfileHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e46",
        provisionedAt: "2026-08-26T01:05:00.000Z",
        lastRefreshAt: "2026-08-30T19:30:00.000Z",
        snapshot: {
          ref: "main",
          sha: "0123456789abcdef0123456789abcdef01234567",
          createdAt: "2026-08-30T19:31:00.000Z",
          mirrorBackupId: "bk_1",
          checkoutBackupId: "bk_2",
        },
        schedules: { refresh: 1, provisionRun: 0, provisionDeadline: 0 },
        // The last disk sample (resident-repos item 55) — a measured resident disk sample.
        disk: {
          at: "2026-09-07T15:30:00.000Z",
          totalKiB: 15_086_920,
          usedKiB: 4_262_360,
          freeKiB: 10_808_176,
          parts: {
            mirror: 371_264,
            deps: 2_244_052,
            checkout: 462_888,
            threads: { "slack:C1:1787954209.398379": 541_860 },
            homes: { worker1: 4, worker3: 2_100_000 },
            other: 640_000,
          },
        },
        threads: [
          {
            threadKey: "slack:C1:1787954209.398379",
            ref: "feat/retries",
            sha: "abcdef1234567890abcdef1234567890abcdef12",
            user: "worker3",
            deps: "hardlink",
            boundAt: "2026-08-30T21:40:00.000Z",
            lastAttachAt: "2026-08-30T21:45:00.000Z",
            evicted: false,
          },
          {
            threadKey: "slack:C1:1787900000.000001",
            ref: "main",
            user: "",
            deps: "install",
            boundAt: "2026-08-20T10:00:00.000Z",
            lastAttachAt: "2026-08-20T10:05:00.000Z",
            evicted: true,
            evictedAt: "2026-08-27T10:00:00.000Z",
            evictedWhy: "merged",
          },
        ],
      },
    },
    {
      resource: "repo:acme/api",
      commands: { test: "npm test" },
      defaultRef: "main",
      live: { state: "down", reason: "provision-failed at clone: fatal: could not read Username" },
    },
  ],
};

// Typed as the report the page renders, so the fixture cannot drift from the
// shape again (a missing `account` once left the preview's costs page blank).
const day = (date: string, bot: number, llm: number): DailyCost => ({
  date,
  containers: {
    "switchboard bot": { cpu: bot * 0.1, memory: bot * 0.8, disk: bot * 0.1, total: bot },
    "thread sandboxes": { cpu: 0.1, memory: 0.2, disk: 0.02, total: 0.32 },
  },
  durableObjects: { RunHistoryDO: 0.12 },
  doRequestsUsd: 0.05,
  doRowsUsd: 0.01,
  doStorageUsd: 0.01,
  workersUsd: 0.03,
  r2Usd: 0.02,
  cloudUsd: bot + 0.56,
  llmUsd: llm,
  total: bot + 0.56 + llm,
});
const COSTS_DAYS = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(NOW - (29 - i) * 86_400_000);
  return day(
    d.toISOString().slice(0, 10),
    0.6 + Math.sin(i / 3) * 0.3 + i * 0.01,
    6 + Math.cos(i / 2) * 4 + (i % 7 === 3 ? 9 : 0),
  );
});
const COSTS_CLOUD_USD = COSTS_DAYS.reduce((s, d) => s + d.cloudUsd, 0);
const COSTS: CostReport = {
  group: "switchboard",
  label: "Switchboard",
  range: { from: COSTS_DAYS[0].date, to: COSTS_DAYS[29].date, days: 30, partialLastDay: true },
  llmAvailable: true,
  days: COSTS_DAYS,
  totals: {
    cloudUsd: COSTS_CLOUD_USD,
    llmUsd: COSTS_DAYS.reduce((s, d) => s + d.llmUsd, 0),
    total: COSTS_DAYS.reduce((s, d) => s + d.total, 0),
    byResource: {
      cpu: 2.1,
      memory: 14.4,
      disk: 0.8,
      durableObjects: 3.6,
      doRows: 0.3,
      doStorage: 0.3,
      workers: 0.9,
      r2: 0.6,
    },
  },
  // Three other tenants' worth on the same account: the "share of account" tile reads 25%.
  account: { cloudUsd: COSTS_CLOUD_USD * 4 },
  attribution: {
    workers: ["switchboard", "switchboard-resident"],
    containerApps: { "app-bot": "switchboard bot", "app-sandbox": "thread sandboxes" },
    durableObjectNamespaces: { "ns-history": "RunHistoryDO" },
    r2Buckets: { "switchboard-resident-cache": "switchboard-resident-cache" },
  },
};

/** The real registry entry's action (identity + declared actor and grants), so the preview row cannot drift from the schedule shape. */
const SELF_IMPROVEMENT = SCHEDULES.filter(isRunSchedule).find((s) => s.name === "self-improvement");
if (!SELF_IMPROVEMENT) throw new Error("web-preview: the schedule registry has no `self-improvement` run schedule");

const SCHEDULED = {
  page: "scheduled" as const,
  now: NOW,
  rows: [
    {
      name: SELF_IMPROVEMENT.name,
      worker: SELF_IMPROVEMENT.worker,
      action: SELF_IMPROVEMENT.action,
      cron: SELF_IMPROVEMENT.cron,
      description: "Weekly self-improvement pass over recent runs.",
      nextFireAt: NOW + 2 * 86_400_000 + 3 * 3_600_000,
      last: {
        firedAt: NOW - 5 * 86_400_000,
        outcome: "completed" as const,
        runId: "hist-1abcdef",
        runHref: "/runs/hist-1",
        detail: "🔍 *Friction proposals* — 244 runs analyzed · 23 recurring patterns · 1 filed",
      },
    },
    {
      name: "resident-watchdog",
      worker: "resident" as const,
      action: { type: "watchdog" as const },
      cron: "*/10 * * * *",
      description: "Sweep resident refresh stalls.",
      nextFireAt: NOW + 480_000,
      last: {
        firedAt: NOW - 130_000,
        outcome: "completed" as const,
        detail: "3/10 residents · 0 re-armed · 0 timed out · 0 errors",
      },
    },
  ],
};

function page(pathname: string, all: boolean): { title: string; seed: PageSeed; status?: number } | null {
  if (pathname === "/runs")
    return {
      title: all ? "All runs" : "(2) Live runs",
      seed: {
        page: "runs",
        all,
        retentionDays: 30,
        now: NOW,
        rows: all ? INDEX_ROWS : INDEX_ROWS.filter((r) => !r.finished),
      },
    };
  if (pathname === "/runs/scheduled") return { title: "Scheduled runs", seed: SCHEDULED };
  if (pathname === "/runs/live-1")
    return {
      title: "Live run",
      seed: {
        page: "run",
        mode: "live",
        id: "live-1",
        eventsUrl: "/runs/live-1/events?t=tok-live-1",
        stopUrl: "/runs/live-1/stop?t=tok-live-1",
        serverNow: 1_700_000_090_000,
        startedAt: 1_700_000_000_000,
      },
    };
  if (pathname === "/runs/hist-1")
    return {
      title: "Run",
      seed: {
        page: "run",
        mode: "history",
        id: "hist-1",
        events: HIST_STREAM as never,
        status: "completed",
        eventCount: HIST_STREAM.length + 3,
        receivedAt: RECEIVED_AT,
        startedAt: NOW - 2_400_000,
        finishedAt: HIST_FINISHED_AT,
        sealedAt: HIST_FINISHED_AT + 2_100,
        replyOk: true,
        durationMs: HIST_FINISHED_AT - RECEIVED_AT,
      },
    };
  if (pathname === "/runs/review-1")
    return {
      title: "Run",
      seed: {
        page: "run",
        mode: "history",
        id: "review-1",
        events: REVIEW_STREAM as never,
        status: "completed",
        eventCount: REVIEW_STREAM.length,
        receivedAt: REVIEW_RECEIVED_AT,
        startedAt: REVIEW_RECEIVED_AT,
        finishedAt: REVIEW_FINISHED_AT,
        sealedAt: REVIEW_FINISHED_AT + 1_400,
        replyOk: true,
        durationMs: REVIEW_FINISHED_AT - REVIEW_RECEIVED_AT,
      },
    };
  if (pathname === "/runs/hist-4")
    return {
      title: "Run",
      seed: {
        page: "run",
        mode: "history",
        id: "hist-4",
        events: VERDICT_STREAM as never,
        status: "completed",
        eventCount: VERDICT_STREAM.length,
        receivedAt: VERDICT_RECEIVED_AT,
        startedAt: VERDICT_RECEIVED_AT + 1_500,
        finishedAt: VERDICT_FINISHED_AT,
        sealedAt: VERDICT_FINISHED_AT + 2_000,
        replyOk: true,
        durationMs: VERDICT_FINISHED_AT - VERDICT_RECEIVED_AT,
      },
    };
  if (pathname.startsWith("/runs/"))
    return { title: "Run not found", seed: { page: "runNotFound", retentionDays: 30 }, status: 404 };
  if (pathname === "/residents") return { title: "Resident repos", seed: { page: "residents", ...RESIDENTS } };
  if (pathname.startsWith("/residents/"))
    return { title: "acme/web", seed: { page: "resident", slug: "acme/web", record: RESIDENTS.residents[0] } };
  if (pathname.startsWith("/costs"))
    return {
      title: "Switchboard spend",
      seed: { page: "costs", report: COSTS, groups: ["api", "web"] },
    };
  return null;
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (assets.serve(req, res)) return;
  if (url.pathname === "/favicon.ico") {
    res.writeHead(200, { "content-type": "image/svg+xml" });
    res.end(FAVICON_ICO_SVG);
    return;
  }
  if (url.pathname === "/runs/live-1/events") return serveLiveStream(res);
  if (url.pathname === "/runs" && url.searchParams.get("stream") === "1") {
    // The index feed: open + heartbeats (rows stay as seeded).
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    res.write("retry: 3000\n\n");
    const hb = setInterval(() => res.write(": hb\n\n"), 15_000);
    res.on("close", () => clearInterval(hb));
    return;
  }
  if (url.pathname.endsWith("/stop") && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state: "stopping" }));
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(302, { location: "/runs" });
    res.end();
    return;
  }
  // Phone-viewport harness (preview only): fixed-width iframes so responsive
  // layouts can be screenshotted regardless of the browser window/zoom.
  if (url.pathname === "/preview") {
    const w = Number(url.searchParams.get("w") ?? 390);
    const pages = (url.searchParams.get("pages") ?? "/runs?all=1,/runs/hist-1").split(",");
    const frames = pages
      .map(
        (p) =>
          `<iframe src="${p.replace(/"/g, "")}" style="width:${w}px;height:800px;border:1px solid #6b6b6b;margin:8px;vertical-align:top;background:#0b0d12"></iframe>`,
      )
      .join("");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body style="background:#3a3a3a;margin:0">${frames}</body></html>`);
    return;
  }
  const p = page(url.pathname, url.searchParams.get("all") === "1");
  if (!p) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not a preview route");
    return;
  }
  // Preview-only: framing allowed so a fixed-width <iframe> can emulate a
  // phone viewport for screenshots. Production keeps frame-ancestors 'none'.
  const { "x-frame-options": _xfo, ...headers } = WEB_HTML_HEADERS;
  res.writeHead(p.status ?? 200, {
    ...headers,
    "content-security-policy": headers["content-security-policy"].replace(
      "frame-ancestors 'none'",
      "frame-ancestors 'self'",
    ),
  });
  res.end(shell(p.title, p.seed));
}).listen(PORT, "127.0.0.1", () => console.log(`web preview on http://localhost:${PORT}/runs (fixtures only, no bot)`));
