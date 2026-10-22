import { describe, expect, it, vi } from "vitest";
import { submitVerdictTool } from "../tools/submit.js";
import { MINUTE_MS, REVIEW_COMPLETION } from "./budgets.js";
import { AGENTS } from "../agents/registry.js";
import type { Executor } from "../execution/executor.js";
import type { FollowUpTurnInput } from "./harness/contract.js";
import type { ReviewVerdict } from "./reviewVerdict.js";
import type { RunEvent } from "./runEvents.js";
import type { Span } from "./trace/types.js";
import {
  VERDICT_TURN_MAX_TURNS,
  VERDICT_TURN_TOOLS,
  runVerdictTurn,
  verdictFollowUp,
  type VerdictTurnTarget,
} from "./verdictTurn.js";

// Feature: docs/reference/specs/agent-review.md item 5 — the verdict turn. The
// turn is driven here as a unit, the session's follow-up entry a spy, so its
// wiring — the clipped budget, the follow-up text, the hook that both
// forwards and reports the verdict — is asserted without a model; the
// dispatcher suite proves the turn end to end through the pi harness.

const PR: VerdictTurnTarget = { repo: "acme/api", number: 700 };
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const VERDICT: ReviewVerdict = {
  verdict: "approve",
  summary: "the rebase is faithful",
  head: HEAD,
  findings: [
    { id: "F1", severity: "minor", file: "docs/public/screenshots/manifest.json", title: "confirm the pictures" },
  ],
};

describe("verdictFollowUp — the user turn the model is given", () => {
  it("names the pull request, what a missing verdict posts as, the submit tool with every field, and the two prohibitions", () => {
    const text = verdictFollowUp(PR);
    expect(text).toContain("acme/api#700");
    expect(text).toContain("Review incomplete — findings not validated");
    expect(text).toContain("submit_verdict");
    expect(text).toContain("exactly once");
    for (const field of [
      "`approve`",
      "`request_changes`",
      "one-line summary",
      "`head`",
      "git rev-parse HEAD",
      "`findings`",
    ])
      expect(text).toContain(field);
    expect(text).toContain("blocking|major|minor|nit");
    expect(text).toContain("Do not re-read the diff");
    expect(text).toContain("do not rewrite the review");
  });
});

describe("runVerdictTurn — one clipped prompt on the run's own pi session (harness-pi item 14)", () => {
  const executor = {
    exec: async () => "",
    readFile: async () => "",
    writeFile: async () => {},
    release: async () => ({ released: true }),
  } as unknown as Executor;

  function turnSpec(over: Partial<Parameters<typeof runVerdictTurn>[0]["turn"]> = {}) {
    const events: RunEvent[] = [];
    const progress: string[] = [];
    const forwarded: ReviewVerdict[] = [];
    const turn = {
      agent: AGENTS.review,
      toolContext: { executor, onVerdict: (v: ReviewVerdict) => forwarded.push(v) },
      onProgress: (n: string) => progress.push(n),
      onEvent: (e: RunEvent) => events.push(e),
      ...over,
    };
    return { turn, events, progress, forwarded };
  }

  it("a later rejected submission clears an earlier approval captured in the verdict turn", async () => {
    const stages: string[] = [];
    const h = turnSpec();
    h.turn.toolContext.onReviewSubmission = async (submission) => {
      stages.push(submission.status);
    };
    h.turn.followUp = async ({ toolContext }) => {
      expect(
        await submitVerdictTool.run(
          { verdict: "approve", summary: "No findings", head: HEAD, findings: [] },
          toolContext,
        ),
      ).toContain("verdict recorded: approve");
      expect(
        await submitVerdictTool.run(
          { verdict: "request_changes", summary: "An issue remains", head: HEAD, findings: [] },
          toolContext,
        ),
      ).toContain("changes requested requires validated findings");
      return "The report is incomplete.";
    };
    const out = await runVerdictTurn({ target: PR, turn: h.turn, logKey: "t" });
    expect(out.verdict).toBeUndefined();
    expect(stages).toEqual(["pending", "accepted", "pending", "rejected"]);
  });

  it("the turn uses at most one minute and preserves two minutes for publication", async () => {
    for (const [remainingMs, minutes] of [
      [20 * MINUTE_MS, 1],
      [2.5 * MINUTE_MS, 0.5],
    ] as const) {
      const followUp = vi.fn(async (input: FollowUpTurnInput) => {
        input.toolContext.onVerdict?.(VERDICT);
        return "ok";
      });
      const { turn } = turnSpec({ followUp, remainingMs: () => remainingMs, clock: () => 1_000 });
      await runVerdictTurn({ target: PR, turn, logKey: "t" });
      expect(followUp.mock.calls[0][0].maxMinutes).toBe(minutes);
      expect(followUp.mock.calls[0][0].deadlineAt).toBe(1_000 + minutes * MINUTE_MS);
    }
  });

  it("skips the model when only the publication reserve remains", async () => {
    const followUp = vi.fn(async () => "unused");
    const { turn, events } = turnSpec({ followUp, remainingMs: () => 2 * MINUTE_MS });
    expect(await runVerdictTurn({ target: PR, turn, logKey: "t" })).toMatchObject({
      verdict: undefined,
      incompleteReason: expect.stringContaining("no time remains"),
    });
    expect(followUp).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      kind: "review_incomplete",
      summary: expect.stringContaining("review incomplete"),
    });
  });

  it("publishes the verdict_turn note and prompts the session once: the follow-up text, the clipped budget (never the shared def's), the turn's tool context with the hook under the caller's span; the verdict reaches the hook and the return value", async () => {
    const followUp = vi.fn(async (input: FollowUpTurnInput) => {
      input.toolContext.onVerdict?.(VERDICT); // the relayed submit_verdict, run in the bot under THIS turn's context
      return "Verdict submitted.";
    });
    const { turn, events, progress, forwarded } = turnSpec({ followUp });
    const span = { id: "s-turn", name: "run.verdict_turn" } as unknown as Span;
    const out = await runVerdictTurn({ span, target: PR, turn, logKey: "t" });
    // the note, before the turn
    expect(events).toEqual([
      expect.objectContaining({
        type: "run_note",
        kind: "verdict_turn",
        summary: expect.stringContaining("acme/api#700"),
      }),
    ]);
    expect(progress.some((p) => p.includes("acme/api#700"))).toBe(true);
    expect(followUp).toHaveBeenCalledTimes(1);
    const input = followUp.mock.calls[0][0];
    expect(input.text).toBe(verdictFollowUp(PR));
    expect(input.maxTurns).toBe(VERDICT_TURN_MAX_TURNS);
    expect(input.tools).toEqual(VERDICT_TURN_TOOLS); // read the head, submit, report — nothing that writes (model-proxy item 6)
    expect(input.maxMinutes).toBe(REVIEW_COMPLETION.verdictMinutes); // no lease remainder was handed
    expect(AGENTS.review.maxTurns).toBeGreaterThan(VERDICT_TURN_MAX_TURNS); // the clip is a clip
    expect(AGENTS.review.maxMinutes).toBeGreaterThan(REVIEW_COMPLETION.verdictMinutes);
    expect(input.span).toBe(span); // the turn's `run.agent` hangs under `run.verdict_turn` (tracing.md item 17)
    expect(input.toolContext.executor).toBe(executor);
    // the verdict reached BOTH the caller's hook and the return value
    expect(forwarded).toEqual([VERDICT]);
    expect(out.verdict).toEqual(VERDICT);
  });

  it("a turn that submits nothing reports undefined (the post step stays fail-closed); a turn pi refuses (the prompt throws) is logged and reports the same, never throws", async () => {
    const a = turnSpec({ followUp: async () => "I stand by the review as written." });
    const out1 = await runVerdictTurn({ target: PR, turn: a.turn, logKey: "t" });
    expect(out1.verdict).toBeUndefined();
    expect(a.forwarded).toEqual([]);
    const b = turnSpec({
      followUp: async () => {
        throw new Error("pi refused the prompt: Agent is already processing");
      },
    });
    const out2 = await runVerdictTurn({ target: PR, turn: b.turn, logKey: "t" });
    expect(out2.verdict).toBeUndefined();
    expect(b.events.filter((e) => e.type === "run_note")).toHaveLength(1); // the note was still published
  });

  // A `finish` plan (run-history item 37): the loop answered before a bot
  // restart and its pi is gone, so there is no session to prompt. The turn
  // runs nothing and says so; the post step posts the no-verdict line.
  it("without a session to prompt (a finish plan) the turn asks nothing: one note saying no session, nothing submitted, no throw", async () => {
    const { turn, events, progress, forwarded } = turnSpec();
    const out = await runVerdictTurn({ target: PR, turn, logKey: "t" });
    expect(out.verdict).toBeUndefined();
    expect(forwarded).toEqual([]);
    expect(progress).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "run_note",
        kind: "verdict_turn",
        summary: expect.stringContaining("no session to ask on"),
      }),
    ]);
  });
});
