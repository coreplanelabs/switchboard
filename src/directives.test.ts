import { describe, expect, it } from "vitest";
import { lastThreadDirectives, parseDirectives } from "./directives.js";

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

  it("is never sticky: a thread carrying budget:30 hands the follow-up its agent, and no budget", () => {
    const sticky = lastThreadDirectives([
      { role: "user", text: "agent:explore budget:30 time the suite" },
      { role: "assistant", text: "done" },
    ]);
    expect(sticky).toEqual({ agent: "explore" });
    expect("budget" in sticky).toBe(false);
  });
});

describe("lastThreadDirectives (thread stickiness)", () => {
  it("returns the last agent/model directives from user turns", () => {
    const sticky = lastThreadDirectives([
      { role: "user", text: "agent:coding fix the thing" },
      { role: "assistant", text: "on it" },
      { role: "user", text: "agent:review model:anthropic/claude-opus-5 check it" },
    ]);
    expect(sticky.agent).toBe("review");
    expect(sticky.model).toBe("anthropic/claude-opus-5");
  });

  it("ignores assistant turns so quoted directives cannot hijack the thread", () => {
    const sticky = lastThreadDirectives([
      { role: "user", text: "agent:coding fix" },
      { role: "assistant", text: "you could try agent:review here" },
    ]);
    expect(sticky.agent).toBe("coding");
  });

  it("is lenient: unknown agents in history are skipped, never thrown", () => {
    const sticky = lastThreadDirectives([
      { role: "user", text: "agent:doesnotexist do something" },
      { role: "user", text: "agent:coding do it" },
      { role: "user", text: "agent:alsofake follow up" },
    ]);
    expect(sticky.agent).toBe("coding");
  });

  it("returns nothing for a thread with no directives", () => {
    const sticky = lastThreadDirectives([{ role: "user", text: "hello" }]);
    expect(sticky.agent).toBeUndefined();
    expect(sticky.model).toBeUndefined();
  });
});
