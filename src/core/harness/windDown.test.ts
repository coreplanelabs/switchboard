import { describe, expect, it } from "vitest";
import {
  softStopAnswer,
  timeBudgetAnswer,
  turnGuardAnswer,
  unlabelledAnswer,
  windDownAnswer,
  windDownEndingOf,
  type EndingFacts,
  type WindDownEnding,
} from "./windDown.js";

// Feature: docs/reference/specs/harness-pi.md item 6 — the finale answer reads
// what the ending established. The words are one function of the harness's
// ending and the run loop's facts, so the card and the record agree whatever
// the salvage and the post-steps found: a torn-down or discarded tree is never
// said to hold work, a pushed head is named, and the guess stands only where
// nothing was measured.

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const BRANCH = "plan/p/u1";
const time: WindDownEnding = { kind: "time", text: "" };
const timeWritten: WindDownEnding = { kind: "time", text: "findings so far: hi" };

describe("windDownAnswer — the finale answer reads what the ending established (harness-pi item 6)", () => {
  it("with no facts the words are the harness's own: the guess that work may exist, and the advice", () => {
    expect(windDownAnswer(time, 45)).toBe(
      "Stopped at the 45-minute budget without finishing. Partial work may exist in the workspace — narrow the task and try again.",
    );
    expect(windDownAnswer(timeWritten, 45)).toBe(
      "⚠️ _Hit the 45-minute budget before finishing — findings so far:_\n\nfindings so far: hi",
    );
    expect(windDownAnswer(time, 45, { workspace: { kind: "unread" } })).toBe(windDownAnswer(time, 45));
  });

  it("a clean tree with a pushed head names the head and drops the partial-work clause and the advice", () => {
    const facts: EndingFacts = { workspace: { kind: "clean", branch: BRANCH, head: HEAD }, description: "submitted" };
    expect(windDownAnswer(time, 45, facts)).toBe(
      `Stopped at the 45-minute budget without finishing. The tree was clean and \`${BRANCH}\` held no unpushed commits — its head \`a1b2c3d\` is on the remote. The PR description was submitted.`,
    );
    expect(windDownAnswer(timeWritten, 45, facts)).toBe(
      `⚠️ _Hit the 45-minute budget before finishing. The tree was clean and \`${BRANCH}\` held no unpushed commits — its head \`a1b2c3d\` is on the remote. The PR description was submitted. Findings so far:_\n\nfindings so far: hi`,
    );
    expect(windDownAnswer(time, 45, { workspace: { kind: "clean" } })).toBe(
      "Stopped at the 45-minute budget without finishing. The tree was clean with no unpushed commits.",
    );
  });

  it("a salvaged tree names the branch and the pushed head, unreviewed, as where a follow-up starts", () => {
    expect(
      windDownAnswer(time, 45, {
        workspace: { kind: "salvaged", branch: BRANCH, head: HEAD },
        description: "not_submitted",
      }),
    ).toBe(
      `Stopped at the 45-minute budget without finishing. What the tree held was pushed to \`${BRANCH}\` at \`a1b2c3d\` by the budget salvage, unreviewed — a follow-up starts from it. No PR description was submitted.`,
    );
  });

  it("work left in a workspace the thread keeps is said to be there, with the way back to it", () => {
    expect(windDownAnswer(time, 45, { workspace: { kind: "left", uncommitted: 2, unpushed: 1, fate: "kept" } })).toBe(
      "Stopped at the 45-minute budget without finishing. 2 uncommitted change(s) and 1 unpushed commit(s) sit in the workspace, kept for this thread until it idles out — a follow-up here reuses them.",
    );
  });

  it("work left in a tree that is discarded or torn down is never said to exist there: the counts, the fate, the advice", () => {
    expect(
      windDownAnswer(time, 45, { workspace: { kind: "left", uncommitted: 2, unpushed: 0, fate: "discarded" } }),
    ).toBe(
      "Stopped at the 45-minute budget without finishing. 2 uncommitted change(s) and 0 unpushed commit(s) were left in the tree and discarded at the run's end — narrow the task and try again.",
    );
    expect(
      windDownAnswer(time, 45, { workspace: { kind: "left", uncommitted: 0, unpushed: 3, fate: "torn_down" } }),
    ).toBe(
      "Stopped at the 45-minute budget without finishing. 0 uncommitted change(s) and 3 unpushed commit(s) were left in the tree, which is torn down since a command may still be running in it — narrow the task and try again.",
    );
  });

  it("a workspace that could not be measured is said so, and a run with no workspace names none", () => {
    expect(windDownAnswer(time, 45, { workspace: { kind: "unmeasured" } })).toBe(
      "Stopped at the 45-minute budget without finishing. The workspace could not be measured, so work may sit unpushed there — narrow the task and try again.",
    );
    expect(windDownAnswer(time, 45, { workspace: { kind: "none" } })).toBe(
      "Stopped at the 45-minute budget without finishing. Narrow the task and try again.",
    );
    expect(windDownAnswer(timeWritten, 45, { workspace: { kind: "none" } })).toBe(windDownAnswer(timeWritten, 45));
  });

  it("the failed write-up's clause stays beside the facts", () => {
    expect(windDownAnswer({ kind: "time", text: "", writeUpFailed: "503" }, 45, { workspace: { kind: "clean" } })).toBe(
      "Stopped at the 45-minute budget without finishing; the model call failed during the wind-down (503), so no write-up came. The tree was clean with no unpushed commits.",
    );
  });

  it("writeUpFailedOnTool: when the finale fell on a tool call the clause says a wait on a tool, not a failed model call", () => {
    const reason = "aborted at the finale bound (3 minutes)";
    // time budget — model call (no writeUpFailedOnTool)
    expect(windDownAnswer({ kind: "time", text: "", writeUpFailed: reason }, 45)).toBe(
      `Stopped at the 45-minute budget without finishing; the model call failed during the wind-down (${reason}), so no write-up came. Partial work may exist in the workspace — narrow the task and try again.`,
    );
    // time budget — tool wait (writeUpFailedOnTool: true)
    expect(windDownAnswer({ kind: "time", text: "", writeUpFailed: reason, writeUpFailedOnTool: true }, 45)).toBe(
      `Stopped at the 45-minute budget without finishing; the finale bound ended the wait on a tool call (${reason}), so no write-up came. Partial work may exist in the workspace — narrow the task and try again.`,
    );
    // turn guard — tool wait
    expect(
      windDownAnswer(
        { kind: "turns", pace: "5 turns in 1 minute", text: "", writeUpFailed: reason, writeUpFailedOnTool: true },
        45,
      ),
    ).toBe(
      `Stopped after 5 turns in 1 minute — that pace looks like a loop — without finishing; the finale bound ended the wait on a tool call (${reason}), so no write-up came. Partial work may exist in the workspace — look for a retry loop in the run's events before trying again.`,
    );
    // soft stop — tool wait
    expect(windDownAnswer({ kind: "soft", text: "", writeUpFailed: reason, writeUpFailedOnTool: true }, 45)).toBe(
      `⏹ Stopped early by an operator (soft stop) before any findings were written; the finale bound ended the wait on a tool call (${reason}), so no write-up came. Partial work may exist in the workspace.`,
    );
    // windDownEndingOf carries writeUpFailedOnTool through
    expect(windDownEndingOf({ kind: "time" }, "", reason, "finale", true)).toEqual({
      kind: "time",
      text: "",
      writeUpFailed: reason,
      writeUpFailedOnTool: true,
    });
    expect(windDownEndingOf({ kind: "time" }, "", reason, "finale")).toEqual({
      kind: "time",
      text: "",
      writeUpFailed: reason,
    });
  });

  it("the turn guard, the soft stop and the unlabelled endings read the same facts with their own reason and advice", () => {
    const clean: EndingFacts = { workspace: { kind: "clean", branch: BRANCH, head: HEAD } };
    const clause = `The tree was clean and \`${BRANCH}\` held no unpushed commits — its head \`a1b2c3d\` is on the remote.`;
    const pace = "12 model turns in 2 minutes";
    expect(windDownAnswer({ kind: "turns", pace, text: "" }, 45, clean)).toBe(
      `Stopped after ${pace} — that pace looks like a loop — without finishing. ${clause}`,
    );
    expect(windDownAnswer({ kind: "turns", pace, text: "" }, 45)).toBe(turnGuardAnswer("", pace));
    expect(windDownAnswer({ kind: "turns", pace, text: "" }, 45, { workspace: { kind: "none" } })).toBe(
      `Stopped after ${pace} — that pace looks like a loop — without finishing. Look for a retry loop in the run's events before trying again.`,
    );
    expect(windDownAnswer({ kind: "soft", text: "" }, 45, clean)).toBe(
      `⏹ Stopped early by an operator (soft stop) before any findings were written. ${clause}`,
    );
    expect(windDownAnswer({ kind: "soft", text: "findings" }, 45, clean)).toBe(
      `⏹ _Stopped early by an operator (soft stop). ${clause} Findings so far:_\n\nfindings`,
    );
    expect(windDownAnswer({ kind: "soft", text: "" }, 45)).toBe(softStopAnswer(""));
    expect(windDownAnswer({ kind: "soft", text: "" }, 45, { workspace: { kind: "none" } })).toBe(
      "⏹ Stopped early by an operator (soft stop) before any findings were written.",
    );
    expect(windDownAnswer({ kind: "unlabelled", text: "", writeUpFailed: "503", ended: "failed" }, 45, clean)).toBe(
      `⚠️ The model call failed (503) and no answer came. ${clause}`,
    );
    expect(windDownAnswer({ kind: "unlabelled", text: "", writeUpFailed: "503", ended: "finale" }, 45, clean)).toBe(
      `⚠️ The write-up never started: the loop-end interrupt went unanswered and the finale bound ended the wait (503). ${clause}`,
    );
    expect(windDownAnswer({ kind: "unlabelled", text: "", writeUpFailed: "503", ended: "failed" }, 45)).toBe(
      unlabelledAnswer("", "503"),
    );
  });

  it("windDownEndingOf hands the loop the ending a wind-down labelled, and nothing for the model's own answer", () => {
    expect(windDownEndingOf({ kind: "time" }, "hi", undefined)).toEqual({ kind: "time", text: "hi" });
    expect(windDownEndingOf({ kind: "turns", pace: "p" }, "", "503")).toEqual({
      kind: "turns",
      pace: "p",
      text: "",
      writeUpFailed: "503",
    });
    expect(windDownEndingOf({ kind: "soft" }, "hi", undefined)).toEqual({ kind: "soft", text: "hi" });
    expect(windDownEndingOf(undefined, "hi", "503", "finale")).toEqual({
      kind: "unlabelled",
      text: "hi",
      writeUpFailed: "503",
      ended: "finale",
    });
    expect(windDownEndingOf(undefined, "hi", undefined)).toBeUndefined();
    // The per-kind functions and the one composer say the same words.
    expect(windDownAnswer({ kind: "time", text: "hi", writeUpFailed: "503" }, 10)).toBe(
      timeBudgetAnswer("hi", 10, "503"),
    );
  });
});
