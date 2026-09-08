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

// Feature: docs/reference/specs/thread-admission.md — one live run per thread; a follow-up
// while a run is in flight is steered into it or refused with a pointer, never
// started as a rival run.

const input = (text: string, over: Partial<FollowUpInput> = {}): FollowUpInput => ({
  text,
  userId: "slack:UALICE",
  at: 1_000,
  ...over,
});

describe("ThreadAdmission — claim and release", () => {
  it("the first claim on a thread starts; a second claim while it is held sees the live run", () => {
    const adm = new ThreadAdmission();
    const first = adm.claim("slack:C:1", { agent: "coding", now: 500 });
    expect(first.kind).toBe("start");
    const second = adm.claim("slack:C:1", { agent: "coding" });
    expect(second.kind).toBe("live");
    expect(second.live).toBe(first.live); // the SAME slot object — its inbox is the live run's
    expect(first.live.startedAt).toBe(500);
    expect(adm.size).toBe(1);
  });

  it("threads are independent: a claim on another thread starts", () => {
    const adm = new ThreadAdmission();
    adm.claim("slack:C:1", { agent: "coding" });
    expect(adm.claim("slack:C:2", { agent: "coding" }).kind).toBe("start");
    expect(adm.size).toBe(2);
  });

  it("release frees the slot and hands back what the run never consumed", () => {
    const adm = new ThreadAdmission();
    const { live } = adm.claim("slack:C:1", { agent: "coding" });
    live.inbox.push(input("also do X"));
    live.inbox.push(input("and Y"));
    expect(adm.release("slack:C:1", live).map((i) => i.text)).toEqual(["also do X", "and Y"]);
    expect(adm.get("slack:C:1")).toBeUndefined();
    expect(adm.claim("slack:C:1", { agent: "coding" }).kind).toBe("start");
  });

  it("a stale release (the slot was re-claimed by a later run) is a no-op and returns nothing", () => {
    const adm = new ThreadAdmission();
    const { live: first } = adm.claim("slack:C:1", { agent: "coding" });
    adm.release("slack:C:1", first);
    const { live: second } = adm.claim("slack:C:1", { agent: "coding" });
    second.inbox.push(input("for the second run"));
    expect(adm.release("slack:C:1", first)).toEqual([]);
    expect(adm.get("slack:C:1")).toBe(second);
    expect(second.inbox.size).toBe(1);
  });

  it("releasing a thread that was never claimed returns nothing", () => {
    const adm = new ThreadAdmission();
    const orphan: LiveThread = { agent: "coding", inbox: new FollowUpInbox(), startedAt: 0 };
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

describe("FollowUpInbox — one durable follow-up folds in once (thread-admission item 5)", () => {
  it("a second push with a ledger seq the inbox has seen — pending or already drained — is ignored; items without a seq are never deduped", () => {
    const inbox = new FollowUpInbox();
    inbox.push(input("a", { at: 1, ledgerSeq: 1 }));
    inbox.push(input("a again", { at: 2, ledgerSeq: 1 })); // the same durable item, from the other path
    inbox.push(input("b", { at: 3 }));
    inbox.push(input("b", { at: 4 }));
    expect(inbox.drain().map((i) => i.text)).toEqual(["a", "b", "b"]);
    inbox.push(input("a once more", { at: 5, ledgerSeq: 1 })); // drained already: still ignored
    inbox.push(input("c", { at: 6, ledgerSeq: 2 }));
    expect(inbox.drain().map((i) => i.text)).toEqual(["c"]);
  });
});

describe("decideFollowUp", () => {
  const live = (agent: string): LiveThread => ({ agent, inbox: new FollowUpInbox(), startedAt: 0 });

  it("a bare follow-up steers into the live run, whatever agent is running — review and ship included", () => {
    for (const agent of ["coding", "general", "research", "review", "ship"]) {
      expect(decideFollowUp(live(agent), {})).toEqual({ kind: "steer" });
    }
  });

  it("a follow-up naming the SAME agent as the live run steers (a re-review sent into a live review is a nudge, not a rival run)", () => {
    expect(decideFollowUp(live("coding"), { agent: "coding" })).toEqual({ kind: "steer" });
    expect(decideFollowUp(live("review"), { agent: "review" })).toEqual({ kind: "steer" });
  });

  it("a follow-up naming a DIFFERENT agent is refused (agent_mismatch) — the only refusal", () => {
    expect(decideFollowUp(live("coding"), { agent: "review" })).toEqual({
      kind: "refuse",
      reason: "agent_mismatch",
      requestedAgent: expect.any(String),
    });
    expect(decideFollowUp(live("review"), { agent: "coding" })).toEqual({
      kind: "refuse",
      reason: "agent_mismatch",
      requestedAgent: expect.any(String),
    });
  });
});

describe("replies", () => {
  const live: LiveThread = {
    agent: "coding",
    inbox: new FollowUpInbox(),
    startedAt: 10_000,
    runLink: "https://sb/runs/r1?t=x",
  };

  it("the steer ack names the agent, the elapsed time and carries the live run's URL bare (the reply path escapes mrkdwn `<url|label>`)", () => {
    const ack = steerAck(live, 73_000);
    expect(ack).toContain("*coding*");
    expect(ack).toContain("63s");
    expect(ack).toContain(" · https://sb/runs/r1?t=x");
    expect(ack).not.toMatch(/[<>]/);
    expect(ack).toMatch(/^↪ /);
  });

  it("the refusal carries the same bare URL", () => {
    const text = refusalReply(live, { requestedAgent: "review" }, 20_000);
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
    const text = refusalReply(live, { requestedAgent: "review" }, 20_000);
    expect(text).toContain("`agent:review`");
    expect(text).toContain("one run per thread");
    expect(text).toContain("*coding*");
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

  it("superseded: the header says the just-written answer was not delivered and demands one complete answer", () => {
    const p = followUpPrompt([input("also X")], { superseded: true });
    expect(p).toContain("That answer was NOT delivered");
    expect(p).toContain("covers the original request AND this follow-up");
    expect(p.endsWith("also X")).toBe(true);
    expect(followUpPrompt([input("also X")])).not.toContain("NOT delivered");
  });

  it("five follow-ups drain as one bulleted list in arrival order, and both headers count them", () => {
    const five = ["a", "b", "c", "d", "e"].map((t, i) => input(t, { at: i }));
    const plain = followUpPrompt(five);
    expect(plain).toMatch(/^↪ 5 follow-ups from the thread, sent while you were working\. Take them into account/);
    expect(plain.endsWith("- a\n- b\n- c\n- d\n- e")).toBe(true);
    const superseded = followUpPrompt(five, { superseded: true });
    expect(superseded).toMatch(/^↪ 5 follow-ups from the thread, sent while you were writing your answer\./);
    expect(superseded).toContain("covers the original request AND all of these follow-ups");
    expect(superseded.endsWith("- a\n- b\n- c\n- d\n- e")).toBe(true);
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
      input("first", { userId: "slack:UALICE", userName: "ann", sourceUrl: "https://s/1", images: [img] }),
      input("second", { userId: "slack:UBOB", userName: "bob", sourceUrl: "https://s/2", documents: [doc] }),
    ]);
    expect(merged).toEqual({
      text: "first\n\nsecond",
      userId: "slack:UBOB",
      userName: "bob",
      sourceUrl: "https://s/2",
      images: [img],
      documents: [doc],
    });
  });

  it("no attachments and no names → those keys are absent, not undefined", () => {
    const merged = mergeFollowUps([input("only")]);
    expect(merged).toEqual({ text: "only", userId: "slack:UALICE" });
  });
});
