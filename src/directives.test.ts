import { describe, expect, it } from "vitest";
import { lastThreadDirectives, parseDirectives, stripDirectiveTokens } from "./directives.js";

// Feature: docs/reference/specs/routing-and-config.md — per-request directives & thread stickiness.

describe("parseDirectives", () => {
  it("extracts agent and model and strips them from the text", () => {
    const d = parseDirectives("agent:review model:openai/gpt-5 look at the failing test");
    expect(d.agent).toBe("review");
    expect(d.model).toBe("openai/gpt-5");
    expect(d.text).toBe("look at the failing test");
  });

  it("accepts directives anywhere in the message", () => {
    const d = parseDirectives("please agent:coding fix the bug model:anthropic/claude-opus-5 now");
    expect(d.agent).toBe("coding");
    expect(d.model).toBe("anthropic/claude-opus-5");
    expect(d.text).toBe("please fix the bug now");
  });

  it("throws on an unknown agent, naming the available ones", () => {
    expect(() => parseDirectives("agent:nonsense hi")).toThrow(/Unknown agent "nonsense"/);
    expect(() => parseDirectives("agent:nonsense hi")).toThrow(/general/);
  });

  it("leaves messages without directives untouched", () => {
    const d = parseDirectives("just a normal question");
    expect(d.agent).toBeUndefined();
    expect(d.model).toBeUndefined();
    expect(d.text).toBe("just a normal question");
  });
});

describe("parseDirectives — effort", () => {
  it("extracts effort:<level> and strips it, like agent/model", () => {
    const d = parseDirectives("agent:coding effort:low fix the flaky test");
    expect(d.agent).toBe("coding");
    expect(d.effort).toBe("low");
    expect(d.text).toBe("fix the flaky test");
  });

  it("rejects an unknown effort level, naming the valid ones", () => {
    expect(() => parseDirectives("effort:turbo do it")).toThrow(
      /Unknown effort "turbo".*low, medium, high, xhigh, max/,
    );
  });

  it("is sticky in a thread like agent/model (user turns only, last wins, lenient)", () => {
    expect(
      lastThreadDirectives([
        { role: "user", text: "effort:high think hard" },
        { role: "assistant", text: "quoting effort:low here must not count" },
        { role: "user", text: "effort:bogus is skipped, not thrown" },
        { role: "user", text: "effort:medium now" },
      ]).effort,
    ).toBe("medium");
  });
});

// docs/reference/specs/routing-and-config.md items 1–3: `budget:<minutes>` is
// the caller's own boundary on ONE run — parsed and stripped like the other
// three, validated at parse (whole minutes, at least the boundary minimum),
// and never sticky: a thread that wants a lower budget on every turn sets a
// user boundary instead.
describe("parseDirectives — budget", () => {
  it("extracts budget:<minutes> as a number and strips it, like agent/model/effort", () => {
    const d = parseDirectives("agent:explore budget:30 time the suite");
    expect(d.agent).toBe("explore");
    expect(d.budget).toBe(30);
    expect(d.text).toBe("time the suite");
    expect(parseDirectives("budget=45 hi").budget).toBe(45); // the `=` spelling the other directives take
    expect(parseDirectives("just a question").budget).toBeUndefined();
  });

  it("refuses anything but a whole number of minutes of at least 2, naming the rule", () => {
    for (const bad of ["budget:1", "budget:0", "budget:abc", "budget:2.5", "budget:-5", "budget:30m"]) {
      expect(() => parseDirectives(`${bad} do it`), bad).toThrow(
        /budget:<minutes> takes a whole number of minutes, at least 2/,
      );
      expect(() => parseDirectives(`${bad} do it`), bad).toThrow(/Invalid budget "/);
    }
    expect(parseDirectives("budget:2 ok").budget).toBe(2);
  });

  it("is never sticky: a thread carrying budget:30 hands the follow-up no budget (and no agent — that is the transcript's)", () => {
    const sticky = lastThreadDirectives([
      { role: "user", text: "agent:explore budget:30 effort:low time the suite" },
      { role: "assistant", text: "done" },
    ]);
    expect(sticky).toEqual({ effort: "low" });
    expect("budget" in sticky).toBe(false);
  });
});

// routing-and-config item 3: the model and the effort carry forward from the
// thread's user turns; the agent never does — a thread's agent is the one
// whose transcript it holds (`stickyAgentOf`, dispatch/thread.ts), so an
// `agent:` token in the history is skipped like a `budget:`.
describe("lastThreadDirectives (thread stickiness)", () => {
  it("returns the last model/effort directives from user turns, and never an agent", () => {
    const sticky = lastThreadDirectives([
      { role: "user", text: "agent:coding effort:high fix the thing" },
      { role: "assistant", text: "on it" },
      { role: "user", text: "agent:review model:anthropic/claude-opus-5 check it" },
    ]);
    expect(sticky).toEqual({ model: "anthropic/claude-opus-5", effort: "high" });
    expect("agent" in sticky).toBe(false);
  });

  it("ignores assistant turns so quoted directives cannot hijack the thread", () => {
    const sticky = lastThreadDirectives([
      { role: "user", text: "model:anthropic/a fix" },
      { role: "assistant", text: "you could try model:anthropic/b here" },
    ]);
    expect(sticky.model).toBe("anthropic/a");
  });

  it("is lenient: an unknown effort in history is skipped, never thrown; an agent token, known or not, is skipped too", () => {
    const sticky = lastThreadDirectives([
      { role: "user", text: "agent:doesnotexist effort:bogus do something" },
      { role: "user", text: "agent:coding effort:low do it" },
      { role: "user", text: "agent:alsofake follow up" },
    ]);
    expect(sticky).toEqual({ effort: "low" });
  });

  it("returns nothing for a thread with no directives", () => {
    const sticky = lastThreadDirectives([{ role: "user", text: "hello" }]);
    expect(sticky).toEqual({});
  });
});

// routing-and-config item 21: the replay harness hides the directive a
// requester typed before it asks the router what they meant.
describe("stripDirectiveTokens (lenient: text as data)", () => {
  it("removes every directive token — an unknown agent and a bad budget included — and collapses the whitespace", () => {
    expect(stripDirectiveTokens("agent:coding fix the  bug model:x/y")).toBe("fix the bug");
    expect(stripDirectiveTokens("agent:nonesuch budget:0 effort=max hi")).toBe("hi");
    expect(stripDirectiveTokens("hello there")).toBe("hello there");
    expect(stripDirectiveTokens("agent:review")).toBe("");
  });

  it("agrees with parseDirectives on a message that parses", () => {
    const text = "agent:review effort:low look at this";
    expect(stripDirectiveTokens(text)).toBe(parseDirectives(text).text);
  });
});

describe("severity:<level>", () => {
  it("parses one of the ladder, strips the token, and refuses anything else by name", () => {
    const d = parseDirectives("severity:major fix the flake");
    expect(d.severity).toBe("major");
    expect(d.text).toBe("fix the flake");
    expect(() => parseDirectives("severity:huge fix it")).toThrow(/blocking, major, minor, nit/);
  });
});

// The grant's renewals ride the request like `budget:` (decision 0046, the
// renewable lease): a whole number from zero to the module's ceiling, one
// request's, never sticky. The cost cap is a scope's word only.
describe("parseDirectives — renewals", () => {
  it("extracts renewals:<count> as a number and strips it; zero is a valid word", () => {
    const d = parseDirectives("renewals:3 fix the flaky suite");
    expect(d.renewals).toBe(3);
    expect(d.text).toBe("fix the flaky suite");
    expect(parseDirectives("renewals=0 hi").renewals).toBe(0);
    expect(parseDirectives("renewals:12 ok").renewals).toBe(12);
    expect(parseDirectives("just a question").renewals).toBeUndefined();
  });

  it("refuses by name anything but a whole number within the ceiling", () => {
    for (const bad of ["renewals:13", "renewals:abc", "renewals:2.5", "renewals:-1", "renewals:3x"]) {
      expect(() => parseDirectives(`${bad} do it`), bad).toThrow(/Invalid renewals "/);
      expect(() => parseDirectives(`${bad} do it`), bad).toThrow(/renewals:<count> takes a whole number from 0 to 12/);
    }
  });

  it("is never carried by a thread", () => {
    expect(lastThreadDirectives([{ role: "user", text: "renewals:3 model:openai/gpt-5 go" }])).toEqual({
      model: "openai/gpt-5",
    });
  });
});
