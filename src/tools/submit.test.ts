import { describe, expect, it } from "vitest";
import { validateToolArguments, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { TITLE_GATE_REPOSITORY, visibleLength, type PrDescription } from "../core/prDescription.js";
import type { RunEvent } from "../core/runEvents.js";
import type { Handoff } from "../core/ship/handoff.js";
import { TOOLSETS } from "./toolsets.js";
import { submitHandoffTool, submitPrDescriptionTool, submitVerdictTool } from "./submit.js";
import type { ToolContext } from "./runnableTool.js";
import {
  buildReviewPostBody,
  recordedVerdictFromTranscript,
  redactVerdict,
  type ReviewVerdict,
} from "../core/reviewVerdict.js";
import { outstandingReviewFindings } from "../core/reviewHistory.js";
import { humanReview } from "../core/testing/humanReview.js";

// The recorders: `submit_verdict`, `submit_dispositions`, `submit_handoff` and
// `submit_pr_description` set dispatcher state through the tool context and
// acknowledge what they recorded; each belongs to exactly the toolset of the
// preset that may say it (src/tools/toolsets.ts).

describe("submit_verdict tool", () => {
  const ctxWith = (onVerdict?: ToolContext["onVerdict"]): ToolContext =>
    ({ executor: {} as ToolContext["executor"], onVerdict }) as ToolContext;

  it("explains how to stop an incomplete review without inventing a finding or recording a verdict", async () => {
    const recorded: ReviewVerdict[] = [];
    const ctx = ctxWith((v) => recorded.push(v));
    expect(
      await submitVerdictTool.run(
        {
          verdict: "request_changes",
          summary: "CI evidence unavailable",
          head: "a".repeat(40),
          findings: [],
          humanFindings: [],
        },
        ctx,
      ),
    ).toBe(
      "error: request_changes requires validated findings. If the review is incomplete, stop without a verdict and explain the missing evidence in your final message; no verdict recorded",
    );
    expect(recorded).toEqual([]);
    await submitVerdictTool.run(
      { verdict: "approve", summary: "Complete review", head: "a".repeat(40), findings: [], humanFindings: [] },
      ctx,
    );
    expect(recorded).toEqual([
      { verdict: "approve", summary: "Complete review", head: "a".repeat(40), findings: [], humanFindings: [] },
    ]);
  });

  const caseReview = (kind: "single" | "pattern" = "pattern", humanGated = false) => {
    const head = "a".repeat(40);
    const prior = outstandingReviewFindings([
      {
        id: 1,
        author: "review[bot]",
        authorType: "Bot",
        head,
        state: "COMMENTED",
        submittedAt: "2026-01-01T00:00:00Z",
        body: buildReviewPostBody("evidence", {
          verdict: "request_changes",
          summary: "fix",
          head,
          findings: [
            {
              id: "F1",
              severity: "major",
              file: "store.ts",
              title: "Retry drops new work",
              kind,
              ...(humanGated ? { humanGated: true as const } : {}),
              ...(kind === "pattern"
                ? {
                    invariant: "Keep the newest write",
                    cases: [
                      { scenario: "A concurrent retry", expected: "Keep the new write" },
                      { scenario: "A restart retry", expected: "Keep the replacement" },
                    ],
                  }
                : { line: 7 }),
            },
          ],
        }),
      },
    ]);
    const recorded: ReviewVerdict[] = [];
    const ctx = {
      ...ctxWith((v) => recorded.push(v)),
      reviewHistory: { target: { repo: "acme/api", number: 7 }, snapshot: { head, findings: prior } },
    };
    const assessments = [
      {
        findingId: "review:1:F1",
        caseId: "C1",
        outcome: "open",
        note: "store.ts still deletes the concurrent write at this head",
      },
      {
        findingId: "review:1:F1",
        caseId: "C2",
        outcome: "fixed",
        note: "store.ts retains the replacement after restart at this head",
      },
    ];
    return { head, prior, recorded, ctx, assessments };
  };

  it.each(["single", "pattern"] as const)(
    "rejects changes to controller-owned %s metadata before approval or human-gated holds",
    async (kind) => {
      const f = caseReview(kind);
      const input = {
        verdict: "approve",
        humanFindings: humanReview("review:1:F1"),
        summary: "Checked",
        head: f.head,
        findings: [{ id: "review:1:F1" }],
        ...(kind === "pattern" ? { caseAssessments: f.assessments } : {}),
      };
      for (const patch of [
        { severity: "nit" },
        { file: "other.ts" },
        { title: "A different issue" },
        { line: 99 },
        { humanGated: true },
        { kind: kind === "single" ? "pattern" : "single" },
        { invariant: "A different rule" },
        ...(kind === "single" ? [{ cases: [{ scenario: "A new path", expected: "Keep work" }] }] : []),
      ]) {
        expect(await submitVerdictTool.run({ ...input, findings: [{ id: "review:1:F1", ...patch }] }, f.ctx)).toMatch(
          /^error:/,
        );
        expect(f.recorded).toEqual([]);
      }
      const receipt = await submitVerdictTool.run(input, f.ctx);
      expect(String(receipt).split("\n")[0]).toMatch(/^verdict recorded: request_changes/);
      const recovered = recordedVerdictFromTranscript([
        { role: "assistant", content: [{ type: "tool_use", id: "v", name: "submit_verdict", input }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "v", content: String(receipt) }] },
      ]);
      expect(recovered?.findings?.[0]).toMatchObject({
        id: "review:1:F1",
        severity: "major",
        file: "store.ts",
        title: "Retry drops new work",
        kind,
      });
      expect(buildReviewPostBody("evidence", recovered)).toMatch(/^Changes requested:/);
      const held = caseReview(kind, true);
      expect(
        await submitVerdictTool.run({ ...input, findings: [{ id: "review:1:F1", humanGated: false }] }, held.ctx),
      ).toMatch(/^error:/);
      expect(await submitVerdictTool.run(input, held.ctx)).toMatch(/^verdict recorded: request_changes/);
      expect(held.recorded[0]?.findings?.[0]?.humanGated).toBe(true);
      expect(buildReviewPostBody("evidence", held.recorded[0])).toContain("Needs human verification");
    },
  );

  it("rejects copied or duplicate new cases instead of keeping a resolved finding actionable", async () => {
    const f = caseReview();
    const input = {
      verdict: "request_changes",
      summary: "Checked",
      humanFindings: humanReview("review:1:F1"),
      head: f.head,
      findings: [{ id: "review:1:F1" }],
      caseAssessments: f.assessments.map((row) => ({ ...row, outcome: "fixed" })),
    };
    for (const cases of [
      [{ scenario: "A concurrent retry", expected: "Keep the new write" }],
      [{ scenario: " A concurrent retry\n", expected: "Keep the new write" }],
      [
        { scenario: "A new rollback path", expected: "Keep the replacement" },
        { scenario: "A new rollback path", expected: "Keep the replacement" },
      ],
    ]) {
      expect(await submitVerdictTool.run({ ...input, findings: [{ id: "review:1:F1", cases }] }, f.ctx)).toMatch(
        /^error:/,
      );
      expect(f.recorded).toEqual([]);
    }
    expect(
      await submitVerdictTool.run(
        {
          ...input,
          findings: [
            { id: "review:1:F1", cases: [{ scenario: "A new rollback path", expected: "Keep the replacement" }] },
          ],
        },
        f.ctx,
      ),
    ).toMatch(/^verdict recorded: request_changes/);
    expect(f.recorded[0]?.findings?.[0]?.cases?.[2]).toEqual({
      id: "C3",
      scenario: "A new rollback path",
      expected: "Keep the replacement",
    });
  });

  it("re-raises prior cases by ID with evidence, preserving text and identity through publication and accepted replay", async () => {
    const f = caseReview();
    const input = {
      verdict: "request_changes",
      summary: "Retry remains unsafe",
      humanFindings: humanReview("review:1:F1"),
      head: f.head,
      findings: [],
      priorFindings: [
        { findingId: "review:1:F1", cases: [{ scenario: "A retry after rollback", expected: "Keep the replacement" }] },
      ],
      caseAssessments: f.assessments,
    };
    const tool: Tool = {
      name: submitVerdictTool.name,
      description: submitVerdictTool.description,
      parameters: submitVerdictTool.inputSchema as Tool["parameters"],
    };
    const validated = validateToolArguments(tool, { type: "toolCall", id: "v", name: tool.name, arguments: input });
    const result = await submitVerdictTool.run(validated, f.ctx);
    expect(result).toMatch(/^verdict recorded: request_changes/);
    expect(f.recorded[0]?.findings?.[0]).toEqual({
      id: "review:1:F1",
      severity: "major",
      file: "store.ts",
      title: "Retry drops new work",
      kind: "pattern",
      invariant: "Keep the newest write",
      cases: [
        { id: "C1", scenario: "A concurrent retry", expected: "Keep the new write" },
        { id: "C2", scenario: "A restart retry", expected: "Keep the replacement" },
        { id: "C3", scenario: "A retry after rollback", expected: "Keep the replacement" },
      ],
    });
    expect(f.recorded[0]?.caseAssessments).toEqual(f.assessments);
    const replay = recordedVerdictFromTranscript([
      { role: "assistant", content: [{ type: "tool_use", id: "v", name: "submit_verdict", input }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "v", content: String(result) }] },
    ]);
    expect(replay).toEqual(f.recorded[0]);
    const redacted = redactVerdict(replay!, (text) => text.replaceAll("store.ts", "checked.ts"));
    expect(redacted.caseAssessments?.[0]).toEqual({
      findingId: "review:1:F1",
      caseId: "C1",
      outcome: "open",
      note: "checked.ts still deletes the concurrent write at this head",
    });
    expect(redacted.findings?.[0]?.cases?.map((row) => row.id)).toEqual(["C1", "C2", "C3"]);
    for (const content of [String(result).split("\n")[0], String(result).slice(0, -1)])
      expect(
        recordedVerdictFromTranscript([
          { role: "assistant", content: [{ type: "tool_use", id: "v", name: "submit_verdict", input }] },
          { role: "user", content: [{ type: "tool_result", toolUseId: "v", content }] },
        ]),
      ).toBeUndefined();
    const body = buildReviewPostBody("evidence", replay);
    expect(body).toContain("store.ts still deletes the concurrent write at this head");
    const next = outstandingReviewFindings([
      {
        id: 2,
        author: "review[bot]",
        authorType: "Bot",
        head: f.head,
        state: "COMMENTED",
        submittedAt: "2026-01-01T00:00:01Z",
        body,
      },
    ]);
    expect(next[0]?.finding.cases).toEqual([
      { id: "C1", scenario: "A concurrent retry", expected: "Keep the new write" },
      { id: "C2", scenario: "A restart retry", expected: "Keep the replacement" },
      { id: "C3", scenario: "A retry after rollback", expected: "Keep the replacement" },
    ]);
  });

  it("refuses missing, unknown, duplicate and unsupported case assessments atomically before accepting a closure", async () => {
    const f = caseReview();
    const assessments = f.assessments.map((row) => ({ ...row, outcome: "fixed" }));
    const input = {
      verdict: "approve",
      summary: "All retry paths checked",
      head: f.head,
      findings: [],
      resolutions: [{ findingId: "review:1:F1", disposition: "fixed", note: "Verified both retry paths in store.ts" }],
      caseAssessments: assessments,
    };
    for (const rows of [
      undefined,
      assessments.slice(0, 1),
      [...assessments, assessments[0]],
      [assessments[0], { ...assessments[1], caseId: "C99" }],
      [assessments[0], { ...assessments[1], findingId: "review:9:F1" }],
      [assessments[0], { ...assessments[1], note: " " }],
      f.assessments,
      assessments.map((row) => ({ ...row, outcome: "declined" })),
      [{ ...assessments[0], note: "x".repeat(121_000) }, assessments[1]],
    ]) {
      expect(await submitVerdictTool.run({ ...input, caseAssessments: rows }, f.ctx)).toMatch(/^error:/);
      expect(f.recorded).toEqual([]);
    }
    const result = await submitVerdictTool.run(input, f.ctx);
    expect(result).toMatch(/^verdict recorded: approve/);
    expect(f.recorded[0]?.caseAssessments).toEqual(assessments);
    expect(f.recorded[0]?.resolutions).toEqual([
      { findingId: "review:1:F1", disposition: "fixed", note: "Verified both retry paths in store.ts" },
    ]);
    expect(
      await submitVerdictTool.run(
        {
          ...input,
          caseAssessments: [
            assessments[0],
            {
              ...assessments[1],
              outcome: "declined",
              note: "The restart path cannot reach this write at the reviewed head",
            },
          ],
        },
        f.ctx,
      ),
    ).toMatch(/^verdict recorded: approve/);
    expect(f.recorded[1]?.caseAssessments?.[1]).toEqual({
      findingId: "review:1:F1",
      caseId: "C2",
      outcome: "declined",
      note: "The restart path cannot reach this write at the reviewed head",
    });
  });

  it("rejects contradictory finding variants in the provider-visible schema", () => {
    const declared: Tool = {
      name: submitVerdictTool.name,
      description: submitVerdictTool.description,
      parameters: submitVerdictTool.inputSchema as Tool["parameters"],
    };
    const wire = convertResponsesTools([declared])[0];
    if (wire.type !== "function") throw new Error("Expected a function tool");
    const tool = { ...declared, parameters: JSON.parse(JSON.stringify(wire.parameters)) as Tool["parameters"] };
    const base = { id: "F1", severity: "major", file: "a.ts", title: "unsafe" };
    const matrix = { invariant: "checked trees", cases: [{ scenario: "write", expected: "refuse" }] };
    const check = (finding: ToolCall["arguments"][string]) =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "probe",
        name: tool.name,
        arguments: {
          verdict: "request_changes",
          summary: "unsafe",
          head: "a".repeat(40),
          findings: [finding],
          humanFindings: humanReview("F1"),
        },
      });
    const invalid: ToolCall["arguments"][string][] = [
      { id: "F1", cases: [] },
      { id: "F1" },
      { ...base, kind: "single", ...matrix },
      { ...base, kind: "pattern" },
      { ...base, kind: "pattern", ...matrix, cases: [] },
      { ...base, kind: "pattern", ...matrix, cases: [{ scenario: " ", expected: "refuse" }] },
    ];
    for (const finding of invalid) expect(() => check(finding)).toThrow();
    expect(check({ ...base, kind: "single" })).toEqual({
      verdict: "request_changes",
      summary: "unsafe",
      head: "a".repeat(40),
      humanFindings: humanReview("F1"),
      findings: [{ id: "F1", severity: "major", file: "a.ts", title: "unsafe", kind: "single" }],
    });
    expect(check({ ...base, kind: "pattern", ...matrix })).toEqual({
      verdict: "request_changes",
      summary: "unsafe",
      head: "a".repeat(40),
      humanFindings: humanReview("F1"),
      findings: [
        {
          id: "F1",
          severity: "major",
          file: "a.ts",
          title: "unsafe",
          kind: "pattern",
          invariant: "checked trees",
          cases: [{ scenario: "write", expected: "refuse" }],
        },
      ],
    });
  });

  it("refuses malformed findings atomically even without bound PR history", async () => {
    const got: unknown[] = [];
    const ctx = ctxWith((v) => got.push(v));
    const valid = { id: "F1", severity: "major", file: "a.ts", title: "unsafe", kind: "single" };
    await submitVerdictTool.run(
      { verdict: "request_changes", findings: [valid], humanFindings: humanReview("F1") },
      ctx,
    );
    for (const findings of [
      [valid, { ...valid, id: "F2", severity: "typo" }],
      [valid, { ...valid, id: "" }],
      [valid, { ...valid, id: "F2", file: "" }],
      {},
      "bad",
      null,
    ]) {
      const result = await submitVerdictTool.run({ verdict: "approve", findings }, ctx);
      expect(String(result)).toMatch(/^error:/);
      expect(String(result)).toContain("no verdict recorded");
      expect(got).toHaveLength(1);
    }
  });

  it("requires a complete exact-head history read and explicit prior-finding coverage for a bound PR review", async () => {
    const got: unknown[] = [];
    const ctx: ToolContext = {
      ...ctxWith((v) => got.push(v)),
      reviewHistory: { target: { repo: "acme/api", number: 7 } },
    };
    const input = { verdict: "approve", summary: "clean", head: "a".repeat(40), findings: [] };
    expect(await submitVerdictTool.run(input, ctx)).toMatch(/history/i);
    ctx.reviewHistory!.snapshot = { head: "b".repeat(40), findings: [] };
    expect(await submitVerdictTool.run(input, ctx)).toMatch(/head/i);
    ctx.reviewHistory!.requiredHead = input.head;
    ctx.reviewHistory!.snapshot = {
      head: input.head,
      findings: [
        {
          reviewId: 1,
          author: "review[bot]",
          head: input.head,
          finding: { id: "review:1:F1", severity: "major", file: "a.ts", title: "Lost write", kind: "single" },
        },
      ],
    };
    expect(await submitVerdictTool.run(input, ctx)).toMatch(/review:1:F1/);
    expect(got).toEqual([]);
    expect(
      await submitVerdictTool.run(
        {
          ...input,
          resolutions: [
            {
              findingId: "review:1:F1",
              disposition: "fixed",
              note: "Verified rollback retains the replacement at this head",
            },
          ],
        },
        ctx,
      ),
    ).toMatch(/^verdict recorded: approve/);
    expect(got).toMatchObject([{ resolutions: [{ findingId: "review:1:F1", disposition: "fixed" }] }]);
    const repeated = { ...input, findings: [{ id: "review:1:F1" }], humanFindings: humanReview("review:1:F1") };
    const receipt = await submitVerdictTool.run(repeated, ctx);
    expect(String(receipt).split("\n")[0]).toMatch(/^verdict recorded: request_changes/);
    expect(
      recordedVerdictFromTranscript([
        { role: "assistant", content: [{ type: "tool_use", id: "v", name: "submit_verdict", input: repeated }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "v", content: String(receipt) }] },
      ])?.findings,
    ).toEqual([{ id: "review:1:F1", severity: "major", file: "a.ts", title: "Lost write", kind: "single" }]);
  });

  it.each(["HEAD", "", undefined, "not-a-commit"])(
    "rejects an unusable reviewed head %s for a bound PR even with complete empty history",
    async (head) => {
      const got: unknown[] = [];
      const ctx: ToolContext = {
        ...ctxWith((v) => got.push(v)),
        reviewHistory: { target: { repo: "acme/api", number: 7 }, snapshot: { head: "a".repeat(40), findings: [] } },
      };
      expect(await submitVerdictTool.run({ verdict: "approve", summary: "clean", head, findings: [] }, ctx)).toMatch(
        /^error:.*valid.*head/i,
      );
      expect(got).toEqual([]);
    },
  );

  it.each([false, true])(
    "rejects the valid old SHA after a substantive move even with matching stale history (%s)",
    async (hasSnapshot) => {
      const got: unknown[] = [];
      const old = "a".repeat(40);
      const current = "b".repeat(40);
      const ctx: ToolContext = {
        ...ctxWith((v) => got.push(v)),
        reviewHistory: {
          target: { repo: "acme/api", number: 7 },
          requiredHead: current,
          ...(hasSnapshot ? { snapshot: { head: old, findings: [] } } : {}),
        },
      };
      expect(
        await submitVerdictTool.run({ verdict: "approve", summary: "clean", head: old, findings: [] }, ctx),
      ).toMatch(/^error: reviewed head differs from the required review head/);
      expect(got).toEqual([]);
    },
  );

  it("keeps fresh findings separate from explicitly re-raised canonical prior references", async () => {
    const { head, ctx, recorded } = caseReview("single");
    const input = {
      verdict: "request_changes",
      summary: "Both boundaries remain",
      humanFindings: humanReview("F2", "review:1:F1"),
      head,
      findings: [
        { id: "F2", kind: "single", severity: "minor", file: "src/new.ts", title: "The new path drops its guard" },
      ],
      priorFindings: [{ findingId: "review:1:F1" }],
    };
    const accepted = validateToolArguments(
      {
        name: submitVerdictTool.name,
        description: submitVerdictTool.description,
        parameters: submitVerdictTool.inputSchema as Tool["parameters"],
      },
      { type: "toolCall", id: "fresh-and-prior", name: submitVerdictTool.name, arguments: input },
    );
    const receipt = await submitVerdictTool.run(accepted, ctx);
    if (typeof receipt !== "string") throw new Error("Expected a text verdict receipt");
    expect(receipt.split("\n")[0]).toBe("verdict recorded: request_changes (2 findings)");
    expect(recorded[0].findings).toMatchObject([
      { id: "F2", title: "The new path drops its guard" },
      { id: "review:1:F1", title: "Retry drops new work" },
    ]);
    expect(
      await submitVerdictTool.run({ ...input, priorFindings: [{ findingId: "review:current-run:F3" }] }, ctx),
    ).toBe(
      "error: priorFindings contains an unissued identity; read complete current-head history; no verdict recorded",
    );
    expect(recorded).toHaveLength(1);
  });

  it("is in the review (readonly) toolset only — coding and research never emit verdicts", () => {
    const names = (key: string) => (TOOLSETS[key] ?? []).map((t) => t.name);
    expect(names("readonly")).toContain("submit_verdict");
    expect(names("full")).not.toContain("submit_verdict");
    expect(names("web")).not.toContain("submit_verdict");
  });

  it("forwards a valid verdict to the context and acknowledges it", async () => {
    const got: unknown[] = [];
    const out = await submitVerdictTool.run(
      { verdict: "approve", summary: "clean", findings: [] },
      ctxWith((v) => got.push(v)),
    );
    expect(got).toEqual([{ verdict: "approve", summary: "clean", findings: [] }]);
    expect(out).toBe("verdict recorded: approve (0 findings)");
  });

  it("forwards the reported head (the commit the agent reviewed) alongside the verdict", async () => {
    const got: unknown[] = [];
    await submitVerdictTool.run(
      { verdict: "approve", summary: "clean", head: "e8e43f480a09b76989b85ebe6a2a254d99a4d2a3", findings: [] },
      ctxWith((v) => got.push(v)),
    );
    expect(got).toEqual([
      { verdict: "approve", summary: "clean", head: "e8e43f480a09b76989b85ebe6a2a254d99a4d2a3", findings: [] },
    ]);
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
      submitVerdictTool.run(
        {
          verdict: "request_changes",
          summary: "bug",
          humanFindings: humanReview("F1"),
          findings: [
            { id: "F1", kind: "single", severity: "major", file: "src/x.ts", title: "The result drops findings" },
          ],
        },
        ctxWith(undefined),
      ),
    ).resolves.toBe("verdict recorded: request_changes (1 finding)");
  });

  // Feature: docs/reference/specs/agent-review.md item 5a — the severity gate
  // at the tool: the dispatcher's level rides the context, the parser holds the
  // approve to it, and the ack tells the model its verdict changed and why.
  describe("the severity gate (agent-review item 5a)", () => {
    const major = {
      id: "F3",
      severity: "major",
      file: "a.vue",
      line: 149,
      title: "drops the first key's ref",
      kind: "single",
    };
    const ctxAt = (level: ToolContext["addressSeverity"], sink: (v: unknown) => void): ToolContext =>
      ({ executor: {} as ToolContext["executor"], onVerdict: sink, addressSeverity: level }) as ToolContext;

    it("without a level on the context the parser's default (minor) holds: an approve over a major is recorded as request_changes and the ack says so", async () => {
      const got: Array<{ verdict: string; summary: string }> = [];
      const out = await submitVerdictTool.run(
        { verdict: "approve", summary: "ship it", findings: [major], humanFindings: humanReview("F3") },
        ctxWith((v) => got.push(v)),
      );
      expect(got[0].verdict).toBe("request_changes");
      expect(got[0].summary).toContain("downgraded from approve");
      expect(String(out)).toContain("verdict recorded: request_changes");
      expect(String(out)).toContain(
        "downgraded from approve: finding F3 (major) at or above minor, the severity to address",
      );
    });

    it("the context's level is the one the parser holds to: at `blocking` the same approve stands and the ack carries no downgrade", async () => {
      const got: Array<{ verdict: string }> = [];
      const out = await submitVerdictTool.run(
        { verdict: "approve", summary: "ship it", findings: [major], humanFindings: humanReview("F3") },
        ctxAt("blocking", (v) => got.push(v as { verdict: string })),
      );
      expect(got[0].verdict).toBe("approve");
      expect(String(out)).toBe("verdict recorded: approve (1 finding)");
    });

    it("at `nit` even a nit downgrades; the sink receives the downgraded verdict, never the model's approve", async () => {
      const got: Array<{ verdict: string }> = [];
      await submitVerdictTool.run(
        {
          verdict: "approve",
          summary: "s",
          findings: [{ ...major, id: "F1", severity: "nit" }],
          humanFindings: humanReview("F1"),
        },
        ctxAt("nit", (v) => got.push(v as { verdict: string })),
      );
      expect(got).toHaveLength(1);
      expect(got[0].verdict).toBe("request_changes");
    });

    it("the description states the rule the code enforces: approve means nothing at or above the severity to address, minor by default; nits alone never block", () => {
      expect(submitVerdictTool.description).toContain("no finding at or above the severity to address remains");
      expect(submitVerdictTool.description).toContain("`minor` by default");
      expect(submitVerdictTool.description).toContain("nits alone never block");
      expect(submitVerdictTool.description).not.toContain("no blocking issues");
    });
  });

  // Feature: docs/reference/specs/agent-ship.md item 6 — the verdict enumerates findings
  // as typed entries with stable ids; the tool text is where the review agent
  // learns the id and severity contract.
  describe("findings (agent-ship item 6)", () => {
    it("declares required `findings` in the input schema, with the finding field shapes and the severity vocabulary", () => {
      const props = submitVerdictTool.inputSchema.properties as Record<string, any>;
      expect(props.findings?.type).toBe("array");
      const item = props.findings.items.anyOf[0];
      expect(item.required).toEqual(expect.arrayContaining(["id", "severity", "file", "title"]));
      expect(item.required).not.toContain("line");
      expect(item.properties.severity.enum).toEqual(["blocking", "major", "minor", "nit"]);
      expect(item.properties.line.type).toBe("integer");
      expect(submitVerdictTool.inputSchema.required).toContain("findings");
    });

    it("exposes a typed invariant and case matrix for pattern findings, with concrete push axes in the tool contract", async () => {
      const item = (submitVerdictTool.inputSchema.properties as Record<string, any>).findings.items.anyOf[1];
      expect(item.properties.kind.enum).toEqual(["pattern"]);
      expect(item.required).toContain("kind");
      expect(item.properties.invariant.type).toBe("string");
      expect(item.properties.cases.items.required).toEqual(["scenario", "expected"]);
      for (const axis of ["source", "destination", "endpoint", "command composition"]) {
        expect(submitVerdictTool.description).toContain(axis);
      }
      const got: unknown[] = [];
      const result = await submitVerdictTool.run(
        {
          verdict: "request_changes",
          humanFindings: humanReview("F1"),
          findings: [
            {
              id: "F1",
              severity: "major",
              file: "src/a.ts",
              title: "Unsafe push",
              kind: "pattern",
              invariant: "Only checked trees publish",
              cases: [{ scenario: "explicit refspec", expected: "checked source" }],
            },
          ],
        },
        ctxWith((v) => got.push(v)),
      );
      expect(String(result).split("\n")[0]).toBe("verdict recorded: request_changes (1 finding)");
      expect(got).toMatchObject([
        {
          findings: [
            {
              invariant: "Only checked trees publish",
              cases: [{ scenario: "explicit refspec", expected: "checked source" }],
            },
          ],
        },
      ]);
    });

    it("requires a new finding to declare single or pattern, and rejects pattern findings without a well-formed case table before recording", async () => {
      const got: unknown[] = [];
      const ctx = ctxWith((v) => got.push(v));
      const base = { id: "F1", severity: "major", file: "src/push.ts", title: "Unsafe push" };
      for (const finding of [
        base,
        { ...base, kind: "pattern" },
        { ...base, kind: "pattern", invariant: "only checked trees" },
        { ...base, kind: "single", invariant: "only checked trees", cases: [{ scenario: "push", expected: "refuse" }] },
        { ...base, kind: "typo" },
      ]) {
        const result = await submitVerdictTool.run({ verdict: "request_changes", findings: [finding] }, ctx);
        expect(String(result)).toMatch(/^error:/);
      }
      expect(got).toEqual([]);
      const accepted = await submitVerdictTool.run(
        {
          verdict: "request_changes",
          humanFindings: humanReview("F1"),
          findings: [
            {
              ...base,
              kind: "pattern",
              invariant: "only checked trees",
              cases: [{ scenario: "push", expected: "refuse" }],
            },
          ],
        },
        ctx,
      );
      expect(accepted).toContain("verdict recorded");
      expect(got).toMatchObject([{ findings: [{ kind: "pattern", invariant: "only checked trees" }] }]);
    });

    it("refuses a missing invariant matrix before replacing a valid verdict", async () => {
      const got: unknown[] = [];
      const ctx = ctxWith((v) => got.push(v));
      await submitVerdictTool.run({ verdict: "approve", findings: [] }, ctx);
      const out = await submitVerdictTool.run(
        {
          verdict: "request_changes",
          findings: [
            {
              id: "F1",
              severity: "major",
              file: "src/a.ts",
              title: "Unsafe push",
              kind: "pattern",
              invariant: "only checked trees",
            },
          ],
        },
        ctx,
      );
      expect(String(out)).toContain("error: invalid invariant case table");
      expect(got).toEqual([{ verdict: "approve", summary: "", findings: [] }]);
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
          humanFindings: humanReview("F1"),
          findings: [{ id: "F1", severity: "major", file: "src/a.ts", line: 3, title: "off by one", kind: "single" }],
        },
        ctxWith((v) => got.push(v)),
      );
      expect(got).toEqual([
        {
          verdict: "request_changes",
          summary: "one bug",
          humanFindings: humanReview("F1"),
          findings: [{ id: "F1", severity: "major", file: "src/a.ts", line: 3, title: "off by one", kind: "single" }],
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
            { id: "F1", severity: "major", file: "a.ts", title: "ok", kind: "single" },
            { id: "F2", severity: "meh", file: "b.ts", title: "bad", kind: "single" },
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
// per review finding through this tool; the runner matches those IDs after the run.
describe("submit_dispositions tool", () => {
  const ctxWith = (
    onDispositions: ToolContext["onDispositions"],
    issuedFindingIds: readonly string[] = ["F1", "F2"],
  ): ToolContext => ({ executor: {} as ToolContext["executor"], onDispositions, issuedFindingIds }) as ToolContext;

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

  it("tells coding runs to copy exact finding IDs, including check IDs", () => {
    expect(tool().description).toContain("check:CI / checks (test)");
    expect(JSON.stringify(tool().inputSchema)).toContain("check:CI / checks (test)");
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
    expect(String(out)).toContain("a later valid call replaces this one");
    expect(String(out)).not.toMatch(/^error:/);
  });

  it("rejects unknown, near-match and duplicate IDs without replacing a prior valid set, then accepts an exact correction", async () => {
    let latest: unknown;
    const ctx = ctxWith((d) => (latest = d), ["F1", "check:ci / bot"]);
    const exact = {
      dispositions: [
        { findingId: "F1", disposition: "fixed", note: "done" },
        { findingId: "check:ci / bot", disposition: "fixed", note: "green" },
      ],
    };
    expect(String(await tool().run(exact, ctx))).toContain("dispositions recorded: 2");
    for (const bad of ["check:ci / bot ci / bot", "check:ci / bot ", "F2", "F1"]) {
      const attempted = {
        dispositions: [exact.dispositions[0], { findingId: bad, disposition: "fixed", note: "wrong" }],
      };
      const out = String(await tool().run(attempted, ctx));
      expect(out).toMatch(/^error:/);
      expect(out).toContain("check:ci / bot");
      expect(latest).toEqual(exact.dispositions);
    }
    expect(String(await tool().run({ dispositions: [exact.dispositions[0]] }, ctx))).toMatch(/^error:/);
    expect(latest).toEqual(exact.dispositions);
    const corrected = { dispositions: exact.dispositions.map((d) => ({ ...d, note: "corrected" })) };
    expect(String(await tool().run(corrected, ctx))).toContain("dispositions recorded: 2");
    expect(latest).toEqual(corrected.dispositions);
  });

  it("refuses unbound or ambiguous issued IDs without recording, including repeated check names", async () => {
    const got: unknown[] = [];
    const sink = (d: unknown) => got.push(d);
    for (const issuedFindingIds of [undefined, "F1", ["check:ci / bot", "check:ci / bot"]]) {
      const ctx = { ...ctxWith(sink), issuedFindingIds } as ToolContext;
      expect(String(await tool().run(valid(), ctx))).toMatch(/^error:/);
    }
    expect(got).toEqual([]);
  });

  it("last valid call wins at the sink", async () => {
    let latest: unknown;
    const ctx = ctxWith((d) => (latest = d));
    await tool().run(valid(), ctx);
    const replacement = {
      dispositions: [
        { findingId: "F1", disposition: "declined", note: "changed my mind" },
        { findingId: "F2", disposition: "fixed", note: "resolved" },
      ],
    };
    await tool().run(replacement, ctx);
    expect(latest).toEqual(replacement.dispositions);
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

  it("a malformed entry is refused with the invalid entry surfaced and the prior set preserved", async () => {
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
    expect(got).toEqual([]);
    expect(String(out)).toMatch(/^error:/);
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

  it("the landed list (issue 1699) is an optional fourth list in the schema — what of the unit was already on the base, and where — forwarded and counted when given, absent when not", async () => {
    const props = submitHandoffTool.inputSchema.properties as Record<string, { items?: { required?: string[] } }>;
    expect(props.landed?.items?.required).toEqual(["what", "where"]);
    expect(submitHandoffTool.inputSchema.required).toEqual(["deviations", "followUps", "unproven"]);
    expect(submitHandoffTool.description).toMatch(/`landed`: what of the unit was already on the base/);
    const got: Handoff[] = [];
    const landed = [{ what: "the empty state", where: "https://github.com/acme/api/pull/3377" }];
    const out = await submitHandoffTool.run(
      { deviations: [], followUps: [], unproven: [], landed },
      ctxWith((h) => got.push(h)),
    );
    expect(got).toEqual([{ deviations: [], followUps: [], unproven: [], landed }]);
    expect(String(out)).toMatch(/^handoff recorded: 0 deviations, 0 follow-ups, 0 unproven, 1 landed;/);
    const without = await submitHandoffTool.run(
      valid(),
      ctxWith((h) => got.push(h)),
    );
    expect("landed" in got[1]!).toBe(false);
    expect(String(without)).not.toMatch(/landed/);
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

  it("accepts schema-valid blank optional pointer risks and records them as absent", async () => {
    const got: PrDescription[] = [];
    const tool: Tool = {
      name: submitPrDescriptionTool.name,
      description: submitPrDescriptionTool.description,
      parameters: submitPrDescriptionTool.inputSchema as Tool["parameters"],
    };
    for (const risk of ["", " \t\n "]) {
      const input = validInput();
      input.pointers = [
        { label: "The thing", text: "What it does.", risk, anchor: { path: "src/a.ts", from: 3, to: 9 } },
      ];
      expect(() =>
        validateToolArguments(tool, {
          type: "toolCall",
          id: "probe",
          name: tool.name,
          arguments: input as ToolCall["arguments"],
        }),
      ).not.toThrow();
      expect(
        await submitPrDescriptionTool.run(
          input,
          ctxWith((d) => got.push(d)),
        ),
      ).toMatch(/PR description recorded/);
      expect(got.at(-1)?.pointers[0].risk).toBeUndefined();
    }
    const count = got.length;
    expect(
      await submitPrDescriptionTool.run(
        { ...validInput(), risk: " " },
        ctxWith((d) => got.push(d)),
      ),
    ).toMatch(/^error:/);
    expect(got).toHaveLength(count);
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

  it("on the repository that carries the title gate, a title the gate would refuse is a string error carrying the gate's own sentence — the run cuts and resubmits in the same turn, and CI's `title` check never sees it; on any other repository, or none, the same title is accepted", async () => {
    const title = "feat(dispatch): every gate refusal is a Refusal with a cause, counted";
    const got: PrDescription[] = [];
    const out = await submitPrDescriptionTool.run(
      { ...validInput(), title },
      { ...ctxWith((d) => got.push(d)), repo: TITLE_GATE_REPOSITORY },
    );
    expect(got).toEqual([]);
    expect(String(out)).toMatch(
      /^error: invalid PR description — title: unknown scope "dispatch" — use one of: dispatcher, core, /,
    );
    expect(String(out)).toContain("(the Areas in docs/reference/code-map.md), or no scope for a tree-wide change");
    // The vocabulary is one repository's; a run elsewhere is never told to use its Areas.
    for (const repo of ["acme/api", undefined]) {
      const accepted: PrDescription[] = [];
      const ok = await submitPrDescriptionTool.run(
        { ...validInput(), title },
        { ...ctxWith((d) => accepted.push(d)), ...(repo ? { repo } : {}) },
      );
      expect(String(ok)).toMatch(/PR description recorded/);
      expect(accepted.map((d) => d.title)).toEqual([title]);
    }
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

  // The refusal carries the cut (docs/reference/specs/pr-description.md item 5):
  // a run that overshoots two caps by a few characters is told, once, every
  // field, how much to remove and a prefix that fits — so the second submit is
  // a copy and there is no third.
  it("an object over two caps is refused once naming BOTH fields, each with the count to remove and a prefix that fits; resubmitting the quoted prefixes is accepted", async () => {
    const risk = `${"blast radius ".repeat(22)}[#9](https://github.com/acme/api/issues/9) then the world`;
    const feedbackWanted = `${"the cut ".repeat(25)}itself`;
    expect(visibleLength(risk)).toBe(305);
    expect(visibleLength(feedbackWanted)).toBe(206);
    const got: PrDescription[] = [];
    const out = String(
      await submitPrDescriptionTool.run(
        { ...validInput(), risk, feedbackWanted },
        ctxWith((d) => got.push(d)),
      ),
    );
    expect(got).toEqual([]);
    expect(out).toMatch(/^error: invalid PR description — /);
    const quoted = (field: string) => {
      const m = out.match(
        new RegExp(
          `${field}: at most (\\d+) visible characters \\(got (\\d+)\\) — remove at least (\\d+) visible characters; a prefix that fits: "([^"]*)"`,
        ),
      );
      expect(m, `${field} in ${out}`).not.toBeNull();
      return { cap: Number(m![1]), got: Number(m![2]), remove: Number(m![3]), prefix: m![4] };
    };
    const fw = quoted("feedbackWanted");
    expect(fw).toMatchObject({ cap: 200, got: 206, remove: 6 });
    expect(visibleLength(fw.prefix)).toBeLessThanOrEqual(200);
    const r = quoted("risk");
    expect(r).toMatchObject({ cap: 300, got: 305, remove: 5 });
    expect(visibleLength(r.prefix)).toBeLessThanOrEqual(300);
    expect(r.prefix).toContain("[#9](https://github.com/acme/api/issues/9)"); // the link's target counted for nothing
    // The second submit is a copy of the two prefixes.
    const ok = await submitPrDescriptionTool.run(
      { ...validInput(), risk: r.prefix, feedbackWanted: fw.prefix },
      ctxWith((d) => got.push(d)),
    );
    expect(String(ok)).toMatch(/PR description recorded/);
    expect(got.map((d) => d.risk)).toEqual([r.prefix]);
  });

  it("a refused submit is on the record: a `description_refused` note carries the redacted object and the issues, before the tool answers", async () => {
    const published: RunEvent[] = [];
    const secret = `ghp_${"A".repeat(36)}`;
    const risk = `${"blast radius ".repeat(23)}the token ${secret} leaks here`;
    const out = String(
      await submitPrDescriptionTool.run(
        { ...validInput(), risk, tldr: "x".repeat(301) },
        { ...ctxWith(() => {}), publish: (e) => published.push(e) },
      ),
    );
    expect(out).toMatch(/^error:/);
    expect(published).toHaveLength(1);
    const note = published[0];
    if (note.type !== "run_note") throw new Error(`not a note: ${note.type}`);
    expect(note.kind).toBe("description_refused");
    expect(note.summary).toBe("description refused: 2 fields over their cap — tldr, risk");
    // The object as submitted, every string leaf redacted like the accepted event's.
    const description = note.description as Record<string, unknown>;
    expect(description.title).toBe("Fix the widget gate");
    expect(description.risk).toContain("«redacted-github-token»");
    expect(JSON.stringify(note)).not.toContain(secret);
    expect(note.issues?.map((i) => i.path)).toEqual(["tldr", "risk"]);
    expect(note.issues?.[0]).toEqual({ path: "tldr", message: "at most 300 visible characters (got 301)", remove: 1 });
    expect(note.issues?.[1]).toMatchObject({ path: "risk", remove: expect.any(Number), prefix: expect.any(String) });
    expect(note.issues?.[1].prefix).not.toContain(secret);
  });

  it("a refusal for reasons other than a cap names the issues on the note too, and the summary says how many", async () => {
    const published: RunEvent[] = [];
    await submitPrDescriptionTool.run(
      { ...validInput(), title: "feat(dispatch): a scope the code map does not name" },
      { ...ctxWith(() => {}), publish: (e) => published.push(e), repo: TITLE_GATE_REPOSITORY },
    );
    expect(published).toHaveLength(1);
    const note = published[0];
    if (note.type !== "run_note") throw new Error(`not a note: ${note.type}`);
    expect(note.summary).toBe("description refused: 1 issue — title");
    expect(note.issues).toEqual([{ path: "title", message: expect.stringMatching(/^unknown scope "dispatch"/) }]);
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

describe("review submission acceptance state", () => {
  it.each(["pending", "accepted"])("a failed %s checkpoint cannot announce an accepted verdict", async (failure) => {
    const accepted: ReviewVerdict[] = [];
    const checkpoints: unknown[] = [];
    const proposal = { verdict: "approve", summary: "No findings", head: "a".repeat(40), findings: [] };
    const ctx = {
      executor: {},
      callId: "original-call",
      onVerdict: (value: ReviewVerdict) => accepted.push(value),
      onReviewSubmission: async (value: { status: string }) => {
        checkpoints.push(value);
        if (value.status === failure) throw new Error("checkpoint unavailable");
      },
    } as unknown as ToolContext;
    await expect(submitVerdictTool.run(proposal, ctx)).rejects.toThrow("checkpoint unavailable");
    expect(accepted).toEqual([]);
    expect(checkpoints[0]).toEqual({ status: "pending", proposal, callId: "original-call" });
  });

  it("keeps the original proposal and rejection separate from the accepted verdict", async () => {
    const seen: unknown[] = [];
    const accepted: ReviewVerdict[] = [];
    const ctx = {
      executor: {},
      onVerdict: (v: ReviewVerdict) => accepted.push(v),
      onReviewSubmission: async (value: unknown) => {
        seen.push(value);
      },
    } as unknown as ToolContext;
    const proposal = {
      verdict: "request_changes",
      summary: "The original report remains",
      head: "a".repeat(40),
      findings: [
        {
          id: "review:current-run:F2",
          kind: "single",
          severity: "major",
          file: "src/x.ts",
          title: "A reported defect remains",
        },
      ],
    };
    const result = await submitVerdictTool.run(proposal, ctx);
    expect(result).toContain("unknown prior finding review:current-run:F2");
    expect(seen).toMatchObject([
      { status: "pending", proposal },
      { status: "rejected", proposal, reason: expect.stringContaining("unknown prior finding") },
    ]);
    const correction = {
      ...proposal,
      findings: [{ ...proposal.findings[0], id: "F1" }],
      humanFindings: humanReview("F1"),
    };
    expect(await submitVerdictTool.run(correction, ctx)).toContain("verdict recorded: request_changes (1 finding)");
    expect(seen.slice(2)).toMatchObject([
      { status: "pending", proposal: correction },
      { status: "accepted", proposal: correction, verdict: { verdict: "request_changes", findings: [{ id: "F1" }] } },
    ]);
    expect(accepted).toMatchObject([
      { verdict: "request_changes", findings: [{ id: "F1", title: "A reported defect remains" }] },
    ]);
  });
});
