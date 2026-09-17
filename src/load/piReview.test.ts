import { describe, expect, it } from "vitest";
import { AGENTS } from "../agents/registry.js";
import type { PiTaskRun, PiToolCallRecord } from "./piRpc.js";
import { PI_REVIEW_TASKS } from "./piReviewTasks.js";
import {
  PI_WRITE_TOOLS,
  reviewChecks,
  reviewFailureReason,
  reviewOutcome,
  reviewPrompt,
  reviewSystemPrompt,
} from "./piReview.js";

// The review suite of `load:pi` (docs/reference/specs/load-harness.md, the
// review suite item): the framing pi gets is the registry's review prompt
// composed as a resident review run composes it, and a task is scored the way
// the review post-step would judge it — a verdict in the house shape naming
// the reviewed head — plus the read-only facts: no write tool ran, the
// checkout is untouched.

const task = PI_REVIEW_TASKS[0];
const HEAD = task.head;
const site = { repo: "acme/api", checkout: "/work/checkout" };
const url = `https://github.com/acme/api/pull/${task.number}`;

const call = (tool: string, over: Partial<PiToolCallRecord> = {}): PiToolCallRecord => ({
  callId: `c-${tool}`,
  tool,
  summary: tool,
  input: {},
  ok: true,
  hookSeen: true,
  gate: "vetted",
  verdict: "allowed",
  ...over,
});

const run = (over: Partial<PiTaskRun> = {}): PiTaskRun => ({
  task: task.name,
  terminal: "settled",
  wallMs: 1000,
  turns: 3,
  retries: 0,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  toolCalls: [call("bash"), call("submit_verdict")],
  prShaped: { reached: false, problems: [] },
  answer: "The review.",
  errors: [],
  eventKinds: {},
  unmapped: [],
  ...over,
});

const approve = {
  verdict: "approve",
  summary: "looks correct",
  head: HEAD,
  findings: [{ id: "F1", severity: "nit", file: "src/x.ts", line: 3, title: "a name" }],
};

describe("reviewSystemPrompt", () => {
  it("is the registry's resident review prompt composed as a review run composes it — the REVIEW TARGET block with the task's coordinates, then the read identity's harness note naming the relayed verdict tool, then the driver's note on the tools this run lacks", () => {
    const system = reviewSystemPrompt(task, site);
    expect(system.startsWith(AGENTS.review.residentSystem!.slice(0, 60))).toBe(true);
    expect(system).toContain("Target repository: acme/api.");
    expect(system).toContain("REVIEW TARGET (resolved by Switchboard before this run");
    expect(system).toContain(`- Pull request: #${task.number} — ${url}`);
    expect(system).toContain(`- Head commit: ${HEAD}`);
    expect(system).toContain(`- Head branch: ${task.headRef}`);
    expect(system).toContain("- Base branch: main");
    expect(system).toContain("Your shell starts in the worktree `/work/checkout`");
    expect(system).toContain(
      "HARNESS NOTE: this run's workspace tools are pi's own — `read`, `bash`, `grep`, `find` and `ls`",
    );
    expect(system).toContain("no `edit` and no `write`");
    expect(system).toContain("Every other tool named above is available under its own name: `submit_verdict`.");
    expect(system).toContain("DRIVER NOTE:");
    for (const absent of ["diff_digest", "update_status", "web_fetch", "list_skills", "use_skill"])
      expect(system).toContain(`\`${absent}\``);
    expect(system).not.toContain("hand-copied");
  });
  it("the prompt is the request as a person would type it: the pull request by URL in the checkout's repository", () => {
    expect(reviewPrompt(task, "acme/api")).toBe(`Review pull request #${task.number} of acme/api: ${url}`);
  });
});

describe("reviewOutcome — one task judged as the post-step would judge it", () => {
  it("a verdict in the house shape naming the reviewed head: the body the post-step would post starts with LGTM: and lists the findings", () => {
    const o = reviewOutcome(run({ verdict: approve }), task);
    expect(o.verdict?.verdict).toBe("approve");
    expect(o.houseShape).toBe(true);
    expect(o.headMatches).toBe(true);
    expect(o.body?.startsWith("LGTM: looks correct\n\n> [!NOTE]\n> **Approved** · ")).toBe(true);
    expect(o.body).toContain("| nit | **F1** a name | `src/x.ts:3` |");
    expect(o.body).toContain("<summary>Full review</summary>\n\nThe review.\n\n</details>");
    expect(o.problems).toEqual([]);
    expect(o.writeCalls).toEqual([]);
  });
  it("request_changes renders the Changes requested: line; no verdict is the no-verdict line and a problem", () => {
    const changes = reviewOutcome(run({ verdict: { ...approve, verdict: "request_changes" } }), task);
    expect(changes.body?.startsWith("Changes requested: looks correct")).toBe(true);
    const none = reviewOutcome(run(), task);
    expect(none.verdict).toBeUndefined();
    expect(none.houseShape).toBe(false);
    expect(none.headMatches).toBe(false);
    expect(none.body?.startsWith("No verdict submitted — not approving.\n\n> [!CAUTION]\n")).toBe(true);
    expect(none.body).toContain("<summary>Full review</summary>\n\nThe review.\n\n</details>");
    expect(none.problems).toEqual(["no verdict submitted"]);
  });
  it("a verdict naming another head, or none, fails the head check the reviewed-head guard would fail — the shape may still hold", () => {
    const other = reviewOutcome(
      run({ verdict: { ...approve, head: "0000000000000000000000000000000000000000" } }),
      task,
    );
    expect(other.houseShape).toBe(true);
    expect(other.headMatches).toBe(false);
    expect(other.problems).toEqual([`the verdict names head 0000000, not the reviewed ${HEAD.slice(0, 7)}`]);
    const short = reviewOutcome(run({ verdict: { ...approve, head: HEAD.slice(0, 12) } }), task);
    expect(short.headMatches).toBe(true);
    const missing = reviewOutcome(run({ verdict: { verdict: "approve", summary: "x" } }), task);
    expect(missing.houseShape).toBe(true);
    expect(missing.headMatches).toBe(false);
    expect(missing.problems).toEqual(["the verdict names no head"]);
  });
  it("a verdict the parser rejects is not the house shape", () => {
    const o = reviewOutcome(run({ verdict: { verdict: "ship it", summary: "x", head: HEAD } }), task);
    expect(o.verdict).toBeUndefined();
    expect(o.houseShape).toBe(false);
    expect(o.problems).toEqual(["the verdict is not approve or request_changes"]);
  });
  it("lists every write tool the model asked for — pi's edit and write, a PR description — by call, whether it ran or pi refused it", () => {
    expect(PI_WRITE_TOOLS).toEqual(["edit", "write", "submit_pr_description"]);
    const o = reviewOutcome(
      run({
        verdict: approve,
        toolCalls: [
          call("bash"),
          call("edit", { callId: "e1", gate: "rejected-by-pi", hookSeen: false, piRejection: "not on the list" }),
          call("write", { callId: "w1" }),
          call("submit_verdict"),
        ],
      }),
      task,
    );
    expect(o.writeCalls).toEqual(["edit e1 (rejected-by-pi)", "write w1 (vetted)"]);
  });
});

describe("reviewFailureReason — the sample's one token", () => {
  it("names the terminal state when the run did not settle, the missing house shape, or the head mismatch — and nothing when the task passed", () => {
    const reason = (r: PiTaskRun) => reviewFailureReason(r, reviewOutcome(r, task));
    expect(reason(run({ verdict: approve }))).toBeUndefined();
    expect(reason(run({ terminal: "budget", verdict: approve }))).toBe("budget");
    expect(reason(run())).toBe("no-house-verdict");
    expect(reason(run({ verdict: { ...approve, head: "0000000000000000000000000000000000000000" } }))).toBe(
      "head-mismatch",
    );
  });
});

describe("reviewChecks — the receipt's verdict rows", () => {
  const row = (over: Partial<Parameters<typeof reviewChecks>[0][number]> = {}) => ({
    task,
    run: run({ verdict: approve }),
    checkout: { clean: true, head: HEAD },
    ...over,
  });
  it("every row passes for a settled task with a house-shaped verdict on the reviewed head, every call vetted, nothing written, the checkout untouched", () => {
    const checks = reviewChecks([row()]);
    expect(checks.map((c) => c.name)).toEqual([
      "every task settled",
      "every task submitted a verdict in the house shape naming the reviewed head",
      "every tool call pi ran was seen by the extension's tool_call hook — none bypassed the gate",
      "no write tool ran — pi's edit and write are off the allowlist, and none was asked for",
      "the checkout is untouched after every task — clean tree, still at the reviewed head",
    ]);
    expect(checks.every((c) => c.pass)).toBe(true);
    expect(checks[1].actual).toBe("1/1 (approve)");
  });
  it("a task that did not settle, a verdict off the house shape or the head, a bypassed call, a write that ran, or a dirtied checkout each fail their row and name the task", () => {
    const failing = reviewChecks([
      row({ run: run({ terminal: "budget", verdict: approve }) }),
      row({ run: run({ verdict: { ...approve, head: "0000000000000000000000000000000000000000" } }) }),
      row({ run: run({ verdict: approve, toolCalls: [call("bash", { gate: "bypassed", hookSeen: false })] }) }),
      row({ run: run({ verdict: approve, toolCalls: [call("write", { callId: "w1" })] }) }),
      row({ checkout: { clean: false, head: HEAD } }),
      row({ checkout: { clean: true, head: "0000000000000000000000000000000000000000" } }),
    ]);
    expect(failing.map((c) => c.pass)).toEqual([false, false, false, false, false]);
    expect(failing[0].actual).toContain("budget");
    expect(failing[1].actual).toContain("not the reviewed");
    expect(failing[2].actual).toContain("bypassed");
    expect(failing[3].actual).toContain("write w1 (vetted)");
    expect(failing[4].actual).toContain("dirty");
    expect(failing[4].actual).toContain("moved");
  });
  it("a write pi refused before the hook did not run and does not fail the write row — it is listed for the reader", () => {
    const checks = reviewChecks([
      row({
        run: run({
          verdict: approve,
          toolCalls: [
            call("edit", { callId: "e1", gate: "rejected-by-pi", hookSeen: false, piRejection: "not on the list" }),
          ],
        }),
      }),
    ]);
    expect(checks[3].pass).toBe(true);
    expect(checks[3].actual).toContain("edit e1 (rejected-by-pi)");
  });
});
