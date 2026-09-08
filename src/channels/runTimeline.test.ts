import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRunTimeline, type TimelineChange } from "./runTimeline.js";

// Feature: features/live-view.md item 13 — the run page folds the flat event
// stream into steps (the model's prose + the calls it explains) and call cards
// (command + its result, with truthful status/exit/size/duration facts).

const call = (id: string, command: string, at?: number) => ({
  type: "tool_call",
  tool: "bash",
  summary: `$ ${command}`,
  callId: id,
  at,
});
const result = (id: string, over: Record<string, unknown> = {}) => ({
  type: "tool_result",
  tool: "bash",
  ok: true,
  summary: "ok",
  callId: id,
  exitCode: 0,
  output: "ok",
  ...over,
});
const kinds = (changes: TimelineChange[]) => changes.map((c) => c.kind);

describe("createRunTimeline — grouping", () => {
  it("calls before any prose form one un-narrated leading step", () => {
    const t = createRunTimeline();
    expect(kinds(t.push(call("a", "ls")))).toEqual(["step", "call"]);
    expect(kinds(t.push(call("b", "pwd")))).toEqual(["call"]);
    expect(t.steps()).toHaveLength(1);
    expect(t.steps()[0].narration).toBeUndefined();
    expect(t.steps()[0].calls.map((c) => c.title)).toEqual(["ls", "pwd"]);
  });

  it("an assistant event opens a new step and the following calls join it", () => {
    const t = createRunTimeline();
    t.push(call("a", "ls"));
    const [step] = t.push({ type: "assistant", text: "Let me look at the diff.", at: 5 });
    expect(step).toMatchObject({
      kind: "step",
      step: { index: 1, narration: { text: "Let me look at the diff.", at: 5 } },
    });
    expect(kinds(t.push(call("b", "git diff")))).toEqual(["call"]);
    expect(t.steps()[1].calls.map((c) => c.title)).toEqual(["git diff"]);
    expect(t.steps()[0].calls).toHaveLength(1); // the earlier step is untouched
  });

  it("pairs a result to its call by callId, even out of order across calls", () => {
    const t = createRunTimeline();
    t.push(call("a", "sleep 5"));
    t.push(call("b", "echo fast"));
    const [ch] = t.push(result("b"));
    expect(ch.kind).toBe("result");
    expect(ch.kind === "result" && ch.call.title).toBe("echo fast");
    expect(t.pending()?.title).toBe("sleep 5");
    t.push(result("a"));
    expect(t.pending()).toBeNull();
  });

  it("a legacy result without callId attaches to the oldest running call of the same tool", () => {
    const t = createRunTimeline();
    t.push({ type: "tool_call", tool: "bash", summary: "$ one" });
    t.push({ type: "tool_call", tool: "bash", summary: "$ two" });
    const [ch] = t.push({ type: "tool_result", tool: "bash", ok: true, summary: "done" });
    expect(ch.kind === "result" && ch.call.title).toBe("one");
  });

  it("an orphan result (its call trimmed from the backlog) becomes its own finished call — nothing is dropped", () => {
    const t = createRunTimeline();
    const changes = t.push(result("ghost", { summary: "exit 1: (40 chars, 3 lines)", ok: false, exitCode: 1 }));
    expect(kinds(changes)).toEqual(["step", "call"]);
    const c = changes[1];
    expect(c.kind === "call" && c.call).toMatchObject({
      title: "bash",
      status: "failed",
      facts: ["exit 1", "3 lines"],
    });
    expect(t.pending()).toBeNull();
  });

  it("passes input / answer / run_note through, and ignores unknown or malformed events", () => {
    const t = createRunTimeline();
    expect(t.push({ type: "input", text: "review #1", at: 1 })).toEqual([{ kind: "input", text: "review #1", at: 1 }]);
    expect(t.push({ type: "answer", text: "LGTM", at: 9 })).toEqual([{ kind: "answer", text: "LGTM", at: 9 }]);
    expect(
      t.push({ type: "run_note", kind: "stop_requested", summary: "stop requested", mode: "soft", at: 3 }),
    ).toEqual([{ kind: "note", text: "stop requested", noteKind: "stop_requested", mode: "soft", at: 3 }]);
    expect(t.push({ type: "run_note", kind: "wrap_up", summary: "wrap up" })).toEqual([
      { kind: "note", text: "wrap up", noteKind: "wrap_up", mode: undefined, at: undefined },
    ]);
    expect(t.push({ type: "mystery" })).toEqual([]);
    expect(t.push(null)).toEqual([]);
    expect(t.push("junk")).toEqual([]);
    expect(t.steps()).toHaveLength(0);
  });
});

describe("createRunTimeline — call cards", () => {
  it("a shell call's title is the command without the `$ ` marker; other tools keep their summary", () => {
    const t = createRunTimeline();
    t.push(call("a", "cd /w && npm test"));
    t.push({ type: "tool_call", tool: "use_skill", summary: "use_skill code-review", callId: "b" });
    const [a, b] = t.steps()[0].calls;
    expect(a).toMatchObject({ title: "cd /w && npm test", shell: true, quiet: false, status: "running" });
    expect(b).toMatchObject({ title: "code-review", headline: "code-review", shell: false, quiet: false });
  });

  it("update_status is a quiet call (one muted line, not a card)", () => {
    const t = createRunTimeline();
    t.push({ type: "tool_call", tool: "update_status", summary: "update_status", callId: "s" });
    expect(t.steps()[0].calls[0].quiet).toBe(true);
  });

  it("derives status from the result: ok / failed (nonzero exit or thrown) / infra", () => {
    const t = createRunTimeline();
    t.push(call("a", "x"));
    t.push(call("b", "y"));
    t.push(call("c", "z"));
    t.push(result("a"));
    t.push(result("b", { ok: false, exitCode: 2, summary: "exit 2: (10 chars, 2 lines)" }));
    t.push(result("c", { ok: false, infra: true, summary: "resident /exec HTTP 503" }));
    expect(t.steps()[0].calls.map((c) => c.status)).toEqual(["ok", "failed", "infra"]);
  });

  it("facts: exit code, line count from the summary's size note (the full output, not the capped text), duration", () => {
    const t = createRunTimeline();
    t.push(call("a", "npm test", 1_000));
    t.push(result("a", { at: 2_250, summary: "✓ all good (5276 chars, 156 lines)", output: "only\nthree\nlines" }));
    expect(t.steps()[0].calls[0].facts).toEqual(["exit 0", "156 lines", "1.3s"]);
  });

  it("facts fall back to the output's line count when the summary carries no size note; single lines are not counted", () => {
    const t = createRunTimeline();
    t.push(call("a", "one", 10));
    t.push(call("b", "two", 10));
    t.push(result("a", { at: 20, summary: "a\nb", output: "a\nb\nc" }));
    t.push(result("b", { at: 900, summary: "ok", output: "ok" }));
    expect(t.steps()[0].calls[0].facts).toEqual(["exit 0", "3 lines", "10ms"]);
    expect(t.steps()[0].calls[1].facts).toEqual(["exit 0", "890ms"]);
  });

  it("facts: a shell failure without a numeric code reads `error`; infra reads `sandbox error`; non-shell shows exit nothing", () => {
    const t = createRunTimeline();
    t.push(call("a", "x"));
    t.push(call("b", "y"));
    t.push({ type: "tool_call", tool: "web_fetch", summary: "web_fetch https://x", callId: "c" });
    t.push({ type: "tool_call", tool: "web_fetch", summary: "web_fetch https://y", callId: "d" });
    t.push(result("a", { ok: false, exitCode: undefined, summary: "exit ETIMEDOUT: boom" }));
    t.push(result("b", { ok: false, infra: true, summary: "dead" }));
    t.push({ type: "tool_result", tool: "web_fetch", ok: true, summary: "200 OK", callId: "c" });
    t.push({ type: "tool_result", tool: "web_fetch", ok: false, summary: "HTTP 404", callId: "d" });
    const [a, b, c, d] = t.steps()[0].calls;
    expect(a.facts).toEqual(["error"]);
    expect(b.facts).toEqual(["sandbox error"]);
    expect(c.facts).toEqual([]);
    expect(d.facts).toEqual(["error"]);
  });

  it("formats durations for humans: ms, one-decimal seconds, minutes", () => {
    const t = createRunTimeline();
    t.push(call("a", "x", 0));
    t.push(call("b", "y", 0));
    t.push(result("a", { at: 61_500 }));
    t.push(result("b", { at: 59_960 }));
    expect(t.steps()[0].calls[0].facts).toContain("1m 02s");
    expect(t.steps()[0].calls[1].facts).toContain("1m 00s"); // 59.96 s rounds up and carries into the minute (F1 of #625);
  });

  it("no duration when either timestamp is missing or the clock ran backwards", () => {
    const t = createRunTimeline();
    t.push(call("a", "x"));
    t.push(call("b", "y", 100));
    t.push(result("a", { at: 50 }));
    t.push(result("b", { at: 40 }));
    expect(t.steps()[0].calls[0].durationMs).toBeUndefined();
    expect(t.steps()[0].calls[1].durationMs).toBeUndefined();
  });

  it("pending() is the oldest call still running, null when everything has a result", () => {
    const t = createRunTimeline();
    expect(t.pending()).toBeNull();
    t.push(call("a", "x"));
    t.push({ type: "assistant", text: "next" });
    t.push(call("b", "y"));
    expect(t.pending()?.title).toBe("x");
    t.push(result("a"));
    expect(t.pending()?.title).toBe("y");
    t.push(result("b"));
    expect(t.pending()).toBeNull();
  });
});

describe("createRunTimeline — classification (open-by-default rules key on these)", () => {
  const tagOf = (command: string) => {
    const t = createRunTimeline();
    t.push(call("a", command));
    return t.steps()[0].calls[0].tags;
  };

  it("tags shell calls by what they do, ignoring leading `cd` hops", () => {
    expect(tagOf("cd /w && npm test 2>&1 | tail -25")).toEqual(["tests"]);
    expect(tagOf("cd /w && npx vitest run src/x.test.ts")).toEqual(["tests"]);
    expect(tagOf("cd /w && npx tsc -p tsconfig.build.json --noEmit")).toEqual(["build"]);
    expect(tagOf("npm run build --if-present")).toEqual(["build"]);
    expect(tagOf("cd /w; npm ci")).toEqual(["install"]);
    expect(tagOf("cd /w && git fetch origin && git log --oneline -5")).toEqual(["git"]);
    expect(tagOf("curl -s https://api.github.com/repos/o/r/pulls/1 | head -c 2000")).toEqual(["network"]);
    expect(tagOf("cd /w && sed -n '300,420p' src/core/dispatcher.ts")).toEqual(["read"]);
    expect(tagOf("ls -la /workspace; cat ~/.netrc")).toEqual(["read"]);
    expect(tagOf("D=/x; export D")).toEqual(["shell"]);
  });

  it("the most specific kind wins over incidental read verbs in the same pipeline", () => {
    expect(tagOf("git diff origin/main...HEAD | head -50")).toEqual(["git"]);
    expect(tagOf('(npm test 2>&1 | tail -25; echo "TEST EXIT: $?")')).toEqual(["tests"]);
  });

  it("non-shell calls are tagged with their tool name", () => {
    const t = createRunTimeline();
    t.push({ type: "tool_call", tool: "use_skill", summary: "use_skill x", callId: "a" });
    expect(t.steps()[0].calls[0].tags).toEqual(["use_skill"]);
  });

  it("a result adds `failed` / `infra` to the tags; a clean result adds nothing", () => {
    const t = createRunTimeline();
    t.push(call("a", "npm test"));
    t.push(call("b", "npm test"));
    t.push(call("c", "npm test"));
    t.push(result("a"));
    t.push(result("b", { ok: false, exitCode: 1 }));
    t.push(result("c", { ok: false, infra: true }));
    expect(t.steps()[0].calls.map((c) => c.tags)).toEqual([["tests"], ["tests", "failed"], ["tests", "infra"]]);
  });

  it("headline is the first line of a multi-line command with a trailing …; a one-liner is itself", () => {
    const t = createRunTimeline();
    t.push(call("a", "for b in x y; do\n  echo $b\ndone"));
    t.push(call("b", "ls -la"));
    expect(t.steps()[0].calls[0].headline).toBe("for b in x y; do …");
    expect(t.steps()[0].calls[1].headline).toBe("ls -la");
  });

  it("headline drops the leading `cd … &&` hops the model prefixes to every command (the full title keeps them)", () => {
    const t = createRunTimeline();
    t.push(call("a", "cd /workspace/threads/slack-C1-17880.1/fix-x && npm test 2>&1 | tail -25"));
    t.push(call("b", "cd /w; cd sub && git status"));
    t.push(call("c", "cd /w"));
    const [a, b, c] = t.steps()[0].calls;
    expect(a.headline).toBe("npm test 2>&1 | tail -25 …");
    expect(a.title).toBe("cd /workspace/threads/slack-C1-17880.1/fix-x && npm test 2>&1 | tail -25");
    expect(b.headline).toBe("git status …");
    expect(c.headline).toBe("cd /w"); // nothing but the hop: keep it
  });

  it("a quoted cd path with spaces is a hop too (review nit on #214)", () => {
    const t = createRunTimeline();
    t.push(call("a", 'cd "/my dir/checkout" && npm test'));
    t.push(call("b", "cd '/my dir' ; git status"));
    expect(t.steps()[0].calls[0]).toMatchObject({ headline: "npm test …", tags: ["tests"] });
    expect(t.steps()[0].calls[1]).toMatchObject({ headline: "git status …", tags: ["git"] });
  });
});

describe("createRunTimeline — DOM-free", () => {
  it("never touches the DOM (the page does DOM only; this stays unit-testable)", () => {
    const src = readFileSync(new URL("./runTimeline.ts", import.meta.url), "utf8");
    expect(src).not.toContain("document.");
    expect(src).not.toContain("innerHTML");
    expect(src).not.toContain("</script");
  });
});

// features/skills.md — a `skill_use` event becomes a `skill` change inside the
// current step (the step whose use_skill call it belongs to), never a call.
describe("createRunTimeline — skill_use", () => {
  it("folds `skill_use` into a `skill` change on the current step, keeping only an http(s) source", () => {
    const t = createRunTimeline();
    t.push({ type: "assistant", text: "Loading the review skill.", at: 1 });
    t.push(call("use_skill", "use_skill code-review-and-quality"));
    const changes = t.push({
      type: "skill_use",
      skill: "code-review-and-quality",
      description: "Conducts multi-axis code review.",
      agent: "review",
      source: "https://github.com/addyosmani/agent-skills/blob/d2c37ef/skills/code-review-and-quality/SKILL.md",
      bodyBytes: 4321,
      at: 7,
    });
    expect(changes).toEqual([
      {
        kind: "skill",
        step: expect.objectContaining({ index: 0 }),
        skill: {
          name: "code-review-and-quality",
          description: "Conducts multi-axis code review.",
          agent: "review",
          source: "https://github.com/addyosmani/agent-skills/blob/d2c37ef/skills/code-review-and-quality/SKILL.md",
          bodyBytes: 4321,
          at: 7,
        },
      },
    ]);
    expect(t.steps()[0].calls).toHaveLength(1); // the skill is not a call
  });

  it("a skill_use before any step opens one; a non-http source is dropped; a nameless event is ignored", () => {
    const t = createRunTimeline();
    const changes = t.push({
      type: "skill_use",
      skill: "tdd",
      description: "",
      agent: "coding",
      source: "javascript:alert(1)",
      bodyBytes: 10,
    });
    expect(kinds(changes)).toEqual(["step", "skill"]);
    expect(changes[1].kind === "skill" && changes[1].skill.source).toBeUndefined();
    expect(t.push({ type: "skill_use", skill: "", agent: "coding", bodyBytes: 1 })).toEqual([]);
  });
});

describe("createRunTimeline — review_artifact (features/reading-diff.md item 5)", () => {
  it("folds a review_artifact to nothing — the panel renders it, the step story does not change shape", () => {
    const t = createRunTimeline();
    t.push(call("bash", "$ ls"));
    expect(
      t.push({
        type: "review_artifact",
        artifact: "reading_diff",
        poweredBy: "git",
        baseRef: "main",
        diff: "d",
        truncated: false,
        at: 1,
      }),
    ).toEqual([]);
    expect(t.steps()[0].calls).toHaveLength(1); // untouched
  });
});

describe("createRunTimeline — run_meta (item 19)", () => {
  it("folds `run_meta` into a `meta` change carrying only the well-typed fields; a meta without agent/model is ignored", () => {
    const t = createRunTimeline();
    expect(
      t.push({
        type: "run_meta",
        agent: "review",
        model: "anthropic/claude-fable-5",
        repo: "acme/web",
        ref: "main",
        pr: 281,
        headSha: "c211fd0abc1234",
        at: 5,
      }),
    ).toEqual([
      {
        kind: "meta",
        agent: "review",
        model: "anthropic/claude-fable-5",
        repo: "acme/web",
        ref: "main",
        pr: 281,
        headSha: "c211fd0abc1234",
        at: 5,
      },
    ]);
    // no repo context → just agent · model; junk fields never make it through
    expect(
      t.push({ type: "run_meta", agent: "general", model: "openai/gpt", pr: -1, headSha: "not a sha", ref: "" }),
    ).toEqual([{ kind: "meta", agent: "general", model: "openai/gpt", at: undefined }]);
    expect(t.push({ type: "run_meta", agent: "", model: "x" })).toEqual([]);
    expect(t.steps()).toEqual([]); // not a step
  });
});

describe("createRunTimeline — model turns (item 15)", () => {
  const turn = (over: Record<string, unknown> = {}) => ({
    type: "turn",
    startedAt: 1_000,
    durationMs: 304_000,
    stopReason: "tool_use",
    at: 305_000,
    ...over,
  });

  it("a `turn` becomes its own change, labelled like the products people already know", () => {
    const t = createRunTimeline();
    const [c] = t.push(turn());
    expect(c).toEqual({ kind: "turn", label: "Thought for 5m 04s", facts: [], durationMs: 304_000, at: 305_000 });
  });

  it("a turn carries the model that took it when the event names one; an unstamped turn has no model key", () => {
    const t = createRunTimeline();
    const [c] = t.push(turn({ model: "anthropic/claude-fable-5" }));
    expect(c).toMatchObject({ kind: "turn", model: "anthropic/claude-fable-5" });
    const [d] = t.push(turn());
    expect(d).not.toHaveProperty("model");
    const [e] = t.push(turn({ model: 42 }));
    expect(e).not.toHaveProperty("model"); // a non-string model is not a model
  });

  it("token usage shows as compact facts: in, out, cached (cached only when present)", () => {
    const t = createRunTimeline();
    const [c] = t.push(
      turn({ durationMs: 1_300, usage: { inputTokens: 12_345, outputTokens: 800, cacheReadTokens: 11_200 } }),
    );
    expect(c).toMatchObject({
      kind: "turn",
      label: "Thought for 1.3s",
      facts: ["12.3k in", "800 out", "11.2k cached"],
    });
    const [d] = t.push(turn({ usage: { inputTokens: 1_250_000, outputTokens: 0 } }));
    expect(d).toMatchObject({ facts: ["1.3M in", "0 out"] });
  });

  it("a turn is a step boundary: the next tool_call opens a new step instead of joining the previous one", () => {
    const t = createRunTimeline();
    t.push(call("a", "ls"));
    t.push(turn());
    expect(kinds(t.push(call("b", "pwd")))).toEqual(["step", "call"]);
    expect(t.steps().map((s) => s.calls.map((c) => c.title))).toEqual([["ls"], ["pwd"]]);
  });

  it("a malformed turn (no numeric duration) is ignored, never thrown on", () => {
    const t = createRunTimeline();
    expect(t.push({ type: "turn", startedAt: "x" })).toEqual([]);
  });
});
