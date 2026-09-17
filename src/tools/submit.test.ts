import { describe, expect, it } from "vitest";
import type { PrDescription } from "../core/prDescription.js";
import type { Handoff } from "../core/ship/handoff.js";
import { TOOLSETS } from "./toolsets.js";
import { submitHandoffTool, submitPrDescriptionTool, submitVerdictTool } from "./submit.js";
import type { ToolContext } from "./runnableTool.js";

// The recorders: `submit_verdict`, `submit_dispositions`, `submit_handoff` and
// `submit_pr_description` set dispatcher state through the tool context and
// acknowledge what they recorded; each belongs to exactly the toolset of the
// preset that may say it (src/tools/toolsets.ts).

describe("submit_verdict tool", () => {
  const ctxWith = (onVerdict?: ToolContext["onVerdict"]): ToolContext =>
    ({ executor: {} as ToolContext["executor"], onVerdict }) as ToolContext;

  it("is in the review (readonly) toolset only — coding and research never emit verdicts", () => {
    const names = (key: string) => (TOOLSETS[key] ?? []).map((t) => t.name);
    expect(names("readonly")).toContain("submit_verdict");
    expect(names("full")).not.toContain("submit_verdict");
    expect(names("web")).not.toContain("submit_verdict");
  });

  it("forwards a valid verdict to the context and acknowledges it", async () => {
    const got: unknown[] = [];
    const out = await submitVerdictTool.run(
      { verdict: "approve", summary: "clean" },
      ctxWith((v) => got.push(v)),
    );
    expect(got).toEqual([{ verdict: "approve", summary: "clean" }]);
    expect(out).toBe("verdict recorded: approve");
  });

  it("forwards the reported head (the commit the agent reviewed) alongside the verdict", async () => {
    const got: unknown[] = [];
    await submitVerdictTool.run(
      { verdict: "approve", summary: "clean", head: "e8e43f480a09b76989b85ebe6a2a254d99a4d2a3" },
      ctxWith((v) => got.push(v)),
    );
    expect(got).toEqual([{ verdict: "approve", summary: "clean", head: "e8e43f480a09b76989b85ebe6a2a254d99a4d2a3" }]);
    expect(submitVerdictTool.inputSchema.required).toContain("head");
  });

  it("rejects anything but the two verdict values without touching the context", async () => {
    const got: unknown[] = [];
    const out = await submitVerdictTool.run(
      { verdict: "LGTM", summary: "x" },
      ctxWith((v) => got.push(v)),
    );
    expect(got).toEqual([]);
    expect(String(out)).toMatch(/^error:/);
  });

  it("tolerates a context with no verdict sink", async () => {
    await expect(
      submitVerdictTool.run({ verdict: "request_changes", summary: "bug" }, ctxWith(undefined)),
    ).resolves.toBe("verdict recorded: request_changes");
  });

  // Feature: docs/reference/specs/agent-ship.md item 6 — the verdict enumerates findings
  // as typed entries with stable ids; the tool text is where the review agent
  // learns the id and severity contract.
  describe("findings (agent-ship item 6)", () => {
    it("declares `findings` in the input schema — optional, with the finding field shapes and the severity vocabulary", () => {
      const props = submitVerdictTool.inputSchema.properties as Record<string, any>;
      expect(props.findings?.type).toBe("array");
      const item = props.findings.items;
      expect(item.required).toEqual(expect.arrayContaining(["id", "severity", "file", "title"]));
      expect(item.required).not.toContain("line");
      expect(item.properties.severity.enum).toEqual(["blocking", "major", "minor", "nit"]);
      expect(item.properties.line.type).toBe("integer");
      expect(submitVerdictTool.inputSchema.required).not.toContain("findings");
    });

    it("the description instructs stable ids (F1, F2, …) and names the severity vocabulary once", () => {
      expect(submitVerdictTool.description).toMatch(/stable/i);
      expect(submitVerdictTool.description).toContain("F1");
      expect(submitVerdictTool.description).toContain("blocking|major|minor|nit");
    });

    it("forwards parsed findings to the verdict sink and reports the count", async () => {
      const got: unknown[] = [];
      const out = await submitVerdictTool.run(
        {
          verdict: "request_changes",
          summary: "one bug",
          findings: [{ id: "F1", severity: "major", file: "src/a.ts", line: 3, title: "off by one" }],
        },
        ctxWith((v) => got.push(v)),
      );
      expect(got).toEqual([
        {
          verdict: "request_changes",
          summary: "one bug",
          findings: [{ id: "F1", severity: "major", file: "src/a.ts", line: 3, title: "off by one" }],
        },
      ]);
      expect(String(out)).toContain("1 finding");
    });

    it("surfaces dropped findings in the ack so the model can resubmit", async () => {
      const out = await submitVerdictTool.run(
        {
          verdict: "request_changes",
          summary: "s",
          findings: [
            { id: "F1", severity: "major", file: "a.ts", title: "ok" },
            { id: "F2", severity: "meh", file: "b.ts", title: "bad" },
          ],
        },
        ctxWith(() => {}),
      );
      expect(String(out)).toContain("F2");
      expect(String(out)).toMatch(/dropped/i);
    });
  });
});

// Feature: docs/reference/specs/agent-ship.md item 6 — fix rounds record one disposition
// per review finding through this tool; the ship orchestrator injects
// the round's known finding ids and consumes the last valid call.
describe("submit_dispositions tool", () => {
  const ctxWith = (onDispositions: ToolContext["onDispositions"]): ToolContext =>
    ({ executor: {} as ToolContext["executor"], onDispositions }) as ToolContext;

  const valid = () => ({
    dispositions: [
      { findingId: "F1", disposition: "fixed", note: "guarded the null path" },
      { findingId: "F2", disposition: "declined", note: "by design" },
    ],
  });

  // Looked up through the toolset so every test exercises the wired instance.
  const tool = () => TOOLSETS.full.find((t) => t.name === "submit_dispositions")!;

  it("is in the coding (full) toolset only — review/web/none never record dispositions", () => {
    const names = (key: string) => (TOOLSETS[key] ?? []).map((t) => t.name);
    expect(names("full")).toContain("submit_dispositions");
    expect(names("readonly")).not.toContain("submit_dispositions");
    expect(names("web")).not.toContain("submit_dispositions");
    expect(names("none")).not.toContain("submit_dispositions");
  });

  it("mutates run state, so it is never side-effect-free (must run strictly in order)", () => {
    expect(tool().sideEffectFree).toBeUndefined();
    expect(tool().failsInText).toBe(true);
  });

  it("forwards a valid set to the context and acknowledges the count", async () => {
    const got: unknown[] = [];
    const out = await tool().run(
      valid(),
      ctxWith((d) => got.push(d)),
    );
    expect(got).toEqual([
      [
        { findingId: "F1", disposition: "fixed", note: "guarded the null path" },
        { findingId: "F2", disposition: "declined", note: "by design" },
      ],
    ]);
    expect(String(out)).toContain("2");
    expect(String(out)).toContain("dispositions recorded"); // every run has the sink: its record
    expect(String(out)).not.toMatch(/^error:/);
  });

  it("records whatever ids the run names: the tool holds no list of the review's findings, so an id the review never issued is recorded like any other and the plan runner drops it when it matches the set to the round", async () => {
    const got: unknown[] = [];
    const out = await tool().run(
      {
        dispositions: [
          { findingId: "F1", disposition: "fixed", note: "n" },
          { findingId: "F9", disposition: "declined", note: "n" },
        ],
      },
      ctxWith((d) => got.push(d)),
    );
    expect(got).toEqual([
      [
        { findingId: "F1", disposition: "fixed", note: "n" },
        { findingId: "F9", disposition: "declined", note: "n" },
      ],
    ]);
    expect(String(out)).toBe("dispositions recorded: 2; a later call replaces this one");
    expect(tool().description).not.toContain("no-op");
    expect(tool().description).not.toContain("fix round");
  });

  it("last valid call wins at the sink", async () => {
    let latest: unknown;
    const ctx = ctxWith((d) => (latest = d));
    await tool().run(valid(), ctx);
    await tool().run({ dispositions: [{ findingId: "F1", disposition: "declined", note: "changed my mind" }] }, ctx);
    expect(latest).toEqual([{ findingId: "F1", disposition: "declined", note: "changed my mind" }]);
  });

  it("a non-array input is a string error — context untouched", async () => {
    const got: unknown[] = [];
    const out = await tool().run(
      { dispositions: "all fixed" },
      ctxWith((d) => got.push(d)),
    );
    expect(got).toEqual([]);
    expect(String(out)).toMatch(/^error:/);
  });

  it("a malformed entry is dropped with the drop surfaced in the ack; the rest are recorded", async () => {
    const got: unknown[][] = [];
    const out = await tool().run(
      {
        dispositions: [
          { findingId: "F1", disposition: "fixed", note: "done" },
          { findingId: "F2", disposition: "wontfix", note: "nope" },
        ],
      },
      ctxWith((d) => got.push(d as unknown[])),
    );
    expect(got).toEqual([[{ findingId: "F1", disposition: "fixed", note: "done" }]]);
    expect(String(out)).toMatch(/dropped/i);
    expect(String(out)).toContain("F2");
  });

  it("a context without the sink (a unit test's, a CLI's; every dispatched run has one) says no run is recording, never a false 'recorded' ack", async () => {
    const out = await tool().run(valid(), ctxWith(undefined));
    expect(String(out)).toBe("no run is recording dispositions here");
    expect(String(out)).not.toContain("dispositions recorded");
    expect(String(out)).not.toMatch(/^error:/);
  });
});

// Feature: docs/reference/specs/pr-description.md — the coding agent's PR deliverable is a
// typed PrDescription submitted through this tool; the dispatcher (not the
// model) renders the GitHub body from it at the pushed head and opens/edits
// the PR. Validation mirrors submit_verdict: a bad object comes back as a
// readable string error (never a throw) so the model can fix it and retry.
// Feature: docs/reference/specs/agent-coding.md item 9 — the typed handoff a
// coding child of a plan unit submits beside its description: the same tool
// path, the dispatcher's sink records it on the run and the pipeline posts it
// to the unit's board issue. Validation mirrors submit_pr_description: a bad
// object is a string error naming the path, never a throw.
describe("submit_handoff tool", () => {
  const ctxWith = (onHandoff?: ToolContext["onHandoff"]): ToolContext =>
    ({ executor: {} as ToolContext["executor"], onHandoff }) as ToolContext;

  const valid = () => ({
    deviations: [{ from: "one re-arm", to: "none", why: "the next unit moves the wake path" }],
    followUps: [{ what: "split the file", where: "src/core/ship/codingChild.ts" }],
    unproven: [],
  });

  it("is in the coding (full) toolset only, beside submit_pr_description — review/web/none never submit handoffs", () => {
    const names = (key: string) => (TOOLSETS[key] ?? []).map((t) => t.name);
    expect(names("full")).toContain("submit_handoff");
    expect(names("full").indexOf("submit_handoff")).toBe(names("full").indexOf("submit_pr_description") + 1);
    expect(names("readonly")).not.toContain("submit_handoff");
    expect(names("web")).not.toContain("submit_handoff");
    expect(names("none")).not.toContain("submit_handoff");
  });

  it("mutates run state, so it is never side-effect-free (must run strictly in order)", () => {
    expect(submitHandoffTool.sideEffectFree).toBeUndefined();
    expect(submitHandoffTool.failsInText).toBe(true);
  });

  it("forwards a valid handoff to the sink, trimmed, and acknowledges it with the counts", async () => {
    const got: Handoff[] = [];
    const input = valid();
    input.followUps[0].what = "  split the file ";
    const out = await submitHandoffTool.run(
      input,
      ctxWith((h) => got.push(h)),
    );
    expect(got).toHaveLength(1);
    expect(got[0].followUps[0].what).toBe("split the file");
    expect(String(out)).toMatch(/^handoff recorded: 1 deviation, 1 follow-up, 0 unproven/);
    expect(String(out)).toMatch(/a later call replaces this one/);
  });

  it("an empty handoff is accepted and forwarded — submitted empty is the contract, never an error", async () => {
    const got: Handoff[] = [];
    const out = await submitHandoffTool.run(
      { deviations: [], followUps: [], unproven: [] },
      ctxWith((h) => got.push(h)),
    );
    expect(got).toEqual([{ deviations: [], followUps: [], unproven: [] }]);
    expect(String(out)).toMatch(/^handoff recorded: 0 deviations, 0 follow-ups, 0 unproven/);
  });

  it("a malformed handoff is a string error naming the path — no throw, the sink untouched", async () => {
    const got: Handoff[] = [];
    const out = await submitHandoffTool.run(
      { deviations: [{ from: "a", to: "b" }], followUps: [], unproven: [] },
      ctxWith((h) => got.push(h)),
    );
    expect(got).toEqual([]);
    expect(String(out)).toMatch(/^error: invalid handoff — deviations\.0\.why/);
    const missing = await submitHandoffTool.run(
      { deviations: [], followUps: [] },
      ctxWith((h) => got.push(h)),
    );
    expect(String(missing)).toMatch(/^error: invalid handoff — unproven: must be an array/);
    expect(got).toEqual([]);
  });

  it("last valid call wins; an invalid call after a valid one leaves the valid one standing", async () => {
    let latest: Handoff | undefined;
    const ctx = ctxWith((h) => (latest = h));
    await submitHandoffTool.run(valid(), ctx);
    await submitHandoffTool.run({ ...valid(), unproven: [{ criterion: "c", why: "w" }] }, ctx);
    expect(latest?.unproven).toEqual([{ criterion: "c", why: "w" }]);
    await submitHandoffTool.run({ deviations: "no" }, ctx);
    expect(latest?.unproven).toEqual([{ criterion: "c", why: "w" }]);
  });

  it("no sink (a unit context) → the truth: nothing recorded, never a false 'recorded' ack", async () => {
    const out = await submitHandoffTool.run(valid(), ctxWith(undefined));
    expect(String(out)).toMatch(/no run is recording a handoff here/);
    expect(String(out)).not.toMatch(/^handoff recorded/);
  });
});

describe("submit_pr_description tool", () => {
  const ctxWith = (onPrDescription?: ToolContext["onPrDescription"]): ToolContext =>
    ({ executor: {} as ToolContext["executor"], onPrDescription }) as ToolContext;

  function validInput(): Record<string, unknown> {
    return {
      title: "Fix the widget gate",
      tldr: "Two sentences.",
      why: "Because.",
      pointers: [{ label: "The thing", text: "What it does.", anchor: { path: "src/a.ts", from: 3, to: 9 } }],
      feedbackWanted: "Nothing in particular.",
      verified: "See validation.",
      decisions: [{ title: "Chose X", rationale: "Y was worse." }],
      risk: "None.",
      validation: { criteria: [{ criterion: "It renders", proof: "`[unit]` this test" }] },
    };
  }

  it("is in the coding (full) toolset only — review/web/none never submit descriptions", () => {
    const names = (key: string) => (TOOLSETS[key] ?? []).map((t) => t.name);
    expect(names("full")).toContain("submit_pr_description");
    expect(names("readonly")).not.toContain("submit_pr_description");
    expect(names("web")).not.toContain("submit_pr_description");
    expect(names("none")).not.toContain("submit_pr_description");
  });

  it("mutates run state, so it is never side-effect-free (must run strictly in order)", () => {
    expect(submitPrDescriptionTool.sideEffectFree).toBeUndefined();
    expect(submitPrDescriptionTool.failsInText).toBe(true);
  });

  it("forwards a valid description to the context, parsed and normalized, and acknowledges it", async () => {
    const got: PrDescription[] = [];
    const out = await submitPrDescriptionTool.run(
      { ...validInput(), title: "  Fix the widget gate  " },
      ctxWith((d) => got.push(d)),
    );
    expect(got).toHaveLength(1);
    expect(got[0].title).toBe("Fix the widget gate"); // trimmed by the schema, not passed through raw
    expect(got[0].pointers[0].anchor).toEqual({ path: "src/a.ts", from: 3, to: 9 });
    expect(String(out)).toMatch(/PR description recorded/);
  });

  it("a missing section is a string error naming the zod path — no throw, context untouched", async () => {
    const got: PrDescription[] = [];
    const { risk: _r, ...noRisk } = validInput();
    const out = await submitPrDescriptionTool.run(
      noRisk,
      ctxWith((d) => got.push(d)),
    );
    expect(got).toEqual([]);
    expect(String(out)).toMatch(/^error:/);
    expect(String(out)).toContain("risk");
  });

  it("a blank title is a string error naming `title`", async () => {
    const got: PrDescription[] = [];
    const out = await submitPrDescriptionTool.run(
      { ...validInput(), title: "   " },
      ctxWith((d) => got.push(d)),
    );
    expect(got).toEqual([]);
    expect(String(out)).toMatch(/^error:/);
    expect(String(out)).toContain("title");
  });

  it("a bad anchor is a string error naming the full path into the pointers", async () => {
    const input = validInput();
    input.pointers = [{ label: "t", text: "d", anchor: { path: "/etc/passwd", from: 1, to: 2 } }];
    const out = await submitPrDescriptionTool.run(
      input,
      ctxWith(() => {}),
    );
    expect(String(out)).toMatch(/^error:/);
    expect(String(out)).toContain("pointers.0.anchor.path");
  });

  it("last valid call wins: a second submission replaces the first at the sink", async () => {
    let latest: PrDescription | undefined;
    const ctx = ctxWith((d) => (latest = d));
    await submitPrDescriptionTool.run(validInput(), ctx);
    await submitPrDescriptionTool.run({ ...validInput(), title: "Second title" }, ctx);
    expect(latest?.title).toBe("Second title");
  });

  it("an invalid call after a valid one leaves the valid one standing", async () => {
    let latest: PrDescription | undefined;
    const ctx = ctxWith((d) => (latest = d));
    await submitPrDescriptionTool.run(validInput(), ctx);
    await submitPrDescriptionTool.run({ ...validInput(), tldr: "" }, ctx);
    expect(latest?.title).toBe("Fix the widget gate");
  });

  it("tolerates a context with no description sink", async () => {
    await expect(submitPrDescriptionTool.run(validInput(), ctxWith(undefined))).resolves.toMatch(
      /PR description recorded/,
    );
  });

  it("declares every field of the map and the folds in the tool input schema (the model's contract); agentNotes is the one optional field", () => {
    const required = submitPrDescriptionTool.inputSchema.required as string[];
    const properties = Object.keys(submitPrDescriptionTool.inputSchema.properties as Record<string, unknown>);
    for (const field of [
      "title",
      "tldr",
      "why",
      "pointers",
      "feedbackWanted",
      "risk",
      "verified",
      "decisions",
      "validation",
    ]) {
      expect(required).toContain(field);
    }
    expect(properties).toContain("agentNotes");
    expect(required).not.toContain("agentNotes");
  });
});

// Feature: docs/reference/specs/execution.md item 11 — the bash tool's per-call timeoutMs:
// default 5 min, model-requestable up to the 20-min ceiling, clamped at the
// tool layer before any executor sees it. No timeoutMs → exactly the old call
// shape, so every executor behaves as before.
