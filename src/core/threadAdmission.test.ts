import { describe, expect, it } from "vitest";
import {
  FollowUpInbox,
  ThreadAdmission,
  decideFollowUp,
  followUpPrompt,
  followUpSnippet,
  mergeFollowUps,
  refusalReply,
  steerAck,
  type FollowUpInput,
  type LiveThread,
} from "./threadAdmission.js";

// Feature: features/thread-admission.md — one live run per thread; a follow-up
// while a run is in flight is steered into it or refused with a pointer, never
// started as a rival run.

const input = (text: string, over: Partial<FollowUpInput> = {}): FollowUpInput => ({ text, userId: "slack:U1", at: 1_000, ...over });

describe("ThreadAdmission — claim and release", () => {
  it("the first claim on a thread starts; a second claim while it is held sees the live run", () => {
    const adm = new ThreadAdmission();
    const first = adm.claim("slack:C:1", { agent: "coding", policy: "steer", now: 500 });
    expect(first.kind).toBe("start");
    const second = adm.claim("slack:C:1", { agent: "coding", policy: "steer" });
    expect(second.kind).toBe("live");
    expect(second.live).toBe(first.live); // the SAME slot object — its inbox is the live run's
    expect(first.live.startedAt).toBe(500);
    expect(adm.size).toBe(1);
  });

  it("threads are independent: a claim on another thread starts", () => {
    const adm = new ThreadAdmission();
    adm.claim("slack:C:1", { agent: "coding", policy: "steer" });
    expect(adm.claim("slack:C:2", { agent: "coding", policy: "steer" }).kind).toBe("start");
    expect(adm.size).toBe(2);
  });

  it("release frees the slot and hands back what the run never consumed", () => {
    const adm = new ThreadAdmission();
    const { live } = adm.claim("slack:C:1", { agent: "coding", policy: "steer" });
    live.inbox.push(input("also do X"));
    live.inbox.push(input("and Y"));
    expect(adm.release("slack:C:1", live).map((i) => i.text)).toEqual(["also do X", "and Y"]);
    expect(adm.get("slack:C:1")).toBeUndefined();
    expect(adm.claim("slack:C:1", { agent: "coding", policy: "steer" }).kind).toBe("start");
  });

  it("a stale release (the slot was re-claimed by a later run) is a no-op and returns nothing", () => {
    const adm = new ThreadAdmission();
    const { live: first } = adm.claim("slack:C:1", { agent: "coding", policy: "steer" });
    adm.release("slack:C:1", first);
    const { live: second } = adm.claim("slack:C:1", { agent: "coding", policy: "steer" });
    second.inbox.push(input("for the second run"));
    expect(adm.release("slack:C:1", first)).toEqual([]);
    expect(adm.get("slack:C:1")).toBe(second);
    expect(second.inbox.size).toBe(1);
  });

  it("releasing a thread that was never claimed returns nothing", () => {
    const adm = new ThreadAdmission();
    const orphan: LiveThread = { agent: "coding", policy: "steer", inbox: new FollowUpInbox(), startedAt: 0 };
    expect(adm.release("slack:C:none", orphan)).toEqual([]);
  });
});

describe("FollowUpInbox", () => {
  it("drain returns pushes oldest-first and empties the inbox; a second drain is empty", () => {
    const inbox = new FollowUpInbox();
    expect(inbox.drain()).toEqual([]);
    inbox.push(input("a", { at: 1 }));
    inbox.push(input("b", { at: 2 }));
    expect(inbox.size).toBe(2);
    expect(inbox.drain().map((i) => i.text)).toEqual(["a", "b"]);
    expect(inbox.size).toBe(0);
    expect(inbox.drain()).toEqual([]);
  });
});

describe("decideFollowUp", () => {
  const live = (agent: string, policy: "steer" | "refuse"): LiveThread => ({ agent, policy, inbox: new FollowUpInbox(), startedAt: 0 });

  it("a bare follow-up into a steerable run steers", () => {
    expect(decideFollowUp(live("coding", "steer"), {})).toEqual({ kind: "steer" });
  });

  it("a follow-up naming the SAME agent as the live run steers", () => {
    expect(decideFollowUp(live("coding", "steer"), { agent: "coding" })).toEqual({ kind: "steer" });
  });

  it("a follow-up naming a DIFFERENT agent is refused (agent_mismatch), whatever the policy", () => {
    expect(decideFollowUp(live("coding", "steer"), { agent: "review" })).toEqual({ kind: "refuse", reason: "agent_mismatch" });
    expect(decideFollowUp(live("review", "refuse"), { agent: "coding" })).toEqual({ kind: "refuse", reason: "agent_mismatch" });
  });

  it("a bare follow-up into a non-steerable run is refused (not_steerable)", () => {
    expect(decideFollowUp(live("review", "refuse"), {})).toEqual({ kind: "refuse", reason: "not_steerable" });
    expect(decideFollowUp(live("review", "refuse"), { agent: "review" })).toEqual({ kind: "refuse", reason: "not_steerable" });
  });
});

describe("replies", () => {
  const live: LiveThread = { agent: "coding", policy: "steer", inbox: new FollowUpInbox(), startedAt: 10_000, runLink: "https://sb/runs/r1?t=x" };

  it("the steer ack names the agent, the elapsed time and carries the live run's URL bare (the reply path escapes mrkdwn `<url|label>`)", () => {
    const ack = steerAck(live, 73_000);
    expect(ack).toContain("*coding*");
    expect(ack).toContain("63s");
    expect(ack).toContain(" · https://sb/runs/r1?t=x");
    expect(ack).not.toMatch(/[<>]/);
    expect(ack).toMatch(/^↪ /);
  });

  it("the refusal carries the same bare URL", () => {
    const text = refusalReply(live, { reason: "agent_mismatch" }, "review", 20_000);
    expect(text).toContain(" · https://sb/runs/r1?t=x");
    expect(text).not.toMatch(/[<>]/);
  });

  it("without a run link (setup still in progress) the ack has no dangling separator or link", () => {
    const ack = steerAck({ ...live, runLink: undefined }, 20_000);
    expect(ack).not.toContain("·");
    expect(ack).not.toContain("http");
    expect(ack).toContain("10s");
  });

  it("the agent-mismatch refusal names the requested agent and says one run per thread", () => {
    const text = refusalReply(live, { reason: "agent_mismatch" }, "review", 20_000);
    expect(text).toContain("`agent:review`");
    expect(text).toContain("one run per thread");
    expect(text).toContain("*coding*");
  });

  it("the not-steerable refusal says the live agent takes no mid-flight follow-ups", () => {
    const text = refusalReply({ ...live, agent: "review", policy: "refuse" }, { reason: "not_steerable" }, undefined, 20_000);
    expect(text).toContain("*review*");
    expect(text).toContain("does not take follow-ups mid-flight");
  });
});

describe("followUpPrompt / followUpSnippet", () => {
  it("one input: header + the text verbatim; several: a bulleted list in arrival order", () => {
    const one = followUpPrompt([input("also remove the anon maps flow")]);
    expect(one).toMatch(/^↪ Follow-up from the thread/);
    expect(one.endsWith("also remove the anon maps flow")).toBe(true);
    expect(one).not.toContain("- also");
    const many = followUpPrompt([input("first"), input("second")]);
    expect(many).toContain("- first\n- second");
  });

  it("the snippet is one line, capped with an ellipsis", () => {
    expect(followUpSnippet(input("a\n  b   c"))).toBe("a b c");
    expect(followUpSnippet(input("x".repeat(100)), 20)).toBe(`${"x".repeat(19)}…`);
  });
});

describe("mergeFollowUps — unconsumed inputs become ONE fresh request", () => {
  it("empty → undefined", () => {
    expect(mergeFollowUps([])).toBeUndefined();
  });

  it("texts join in order; attachments concatenate; identity comes from the most recent input", () => {
    const img = { mediaType: "image/png", data: "AAA" };
    const doc = { mediaType: "application/pdf", data: "BBB", name: "spec.pdf" };
    const merged = mergeFollowUps([
      input("first", { userId: "slack:U1", userName: "ann", sourceUrl: "https://s/1", images: [img] }),
      input("second", { userId: "slack:U2", userName: "bob", sourceUrl: "https://s/2", documents: [doc] }),
    ]);
    expect(merged).toEqual({ text: "first\n\nsecond", userId: "slack:U2", userName: "bob", sourceUrl: "https://s/2", images: [img], documents: [doc] });
  });

  it("no attachments and no names → those keys are absent, not undefined", () => {
    const merged = mergeFollowUps([input("only")]);
    expect(merged).toEqual({ text: "only", userId: "slack:U1" });
  });
});
