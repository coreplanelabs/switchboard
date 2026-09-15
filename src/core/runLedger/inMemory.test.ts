import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../providers/types.js";
import type { RunRecord } from "../runRecord.js";
import { InMemoryRunLedger } from "./inMemory.js";
import { DEFAULT_SESSION_LOG_MAX_BYTES, GAP_MARKER } from "./sessionLog.js";
import { ATTACHMENT_REF_BYTES, LEASE_MS, type ClaimRequest, type StepRecord } from "./types.js";

// The reference ledger (docs/reference/specs/run-history.md items 28–31, 33): the whole
// protocol over one object, in the shape the Durable Object mirrors.

const seedTurns: ChatMessage[] = [
  { role: "user", content: [{ type: "text", text: "review this" }] },
  { role: "assistant", content: [{ type: "text", text: "on it" }] },
];

const claimReq = (runId: string, threadKey: string, gen = "g1"): ClaimRequest => ({
  runId,
  threadKey,
  gen,
  leaseMs: LEASE_MS,
  startedAt: 1_000,
  meta: { agent: "review", channelId: "slack:C1", userId: "slack:UALICE", threadKey },
  card: { channel: "C1", ts: "1.0" },
  system: "you are a reviewer",
  tools: [{ name: "bash", description: "run", inputSchema: {} }],
});

const stepRecord = (step: number, turnIndex: number, inFlight: StepRecord["inFlight"] = []): StepRecord => ({
  step,
  seq: step * 10,
  turnIndex,
  inFlight,
  inboxConsumedSeq: 0,
  remainingMs: 600_000,
  turn: step,
  iteration: step,
});

const record = (id: string): RunRecord =>
  ({
    id,
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey: "slack:C1:1.0",
    startedAt: 1_000,
    finishedAt: 5_000,
    status: "completed",
    eventCount: 0,
    storedEventCount: 0,
    truncated: false,
    events: [],
    diagnosis: { eventCount: 0, toolCalls: 0, byCategory: {}, findings: [], verdict: "none" },
  }) as unknown as RunRecord;

describe("InMemoryRunLedger", () => {
  it("claim → seed → steps → finishing → finish: the live row exists between claim and finish, the transcript reads back whole", async () => {
    const ledger = new InMemoryRunLedger(() => 0);
    expect(await ledger.claim(claimReq("r1", "slack:C1:1.0"))).toEqual({ ok: true });
    expect((await ledger.listLive()).map((r) => r.runId)).toEqual(["r1"]);
    expect(
      await ledger.seed(
        "r1",
        "g1",
        seedTurns.map((message, idx) => ({ idx, message })),
      ),
    ).toEqual({ ok: true });
    const assistant: ChatMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "ls" } }],
    };
    expect(
      await ledger.step("r1", "g1", stepRecord(1, 3, [{ callId: "c1", tool: "bash" }]), [
        { idx: 2, message: assistant },
      ]),
    ).toEqual({ ok: true });
    const transcript = await ledger.readTranscript("r1");
    expect(transcript).toMatchObject({ complete: true, turns: 3 });
    expect(transcript.messages[2]).toEqual(assistant);
    expect(await ledger.finishing("r1", "g1")).toEqual({ ok: true });
    expect(await ledger.finish("r1", "g1", record("r1"))).toEqual({ ok: true, stored: true });
    expect(await ledger.listLive()).toEqual([]);
    expect(ledger.finished.has("r1")).toBe(true);
    expect(await ledger.readTranscript("r1")).toEqual({ complete: true, turns: 0, messages: [], compactions: [] });
  });

  it("a second claim on the same thread is refused with the live run; a different thread is fine; the same run by its owner is idempotent", async () => {
    const ledger = new InMemoryRunLedger(() => 0);
    await ledger.claim(claimReq("r1", "slack:C1:1.0"));
    expect(await ledger.claim(claimReq("r2", "slack:C1:1.0"))).toEqual({
      ok: false,
      reason: "thread-live",
      live: { runId: "r1", agent: "review", startedAt: 1_000 },
    });
    expect(await ledger.claim(claimReq("r3", "slack:C1:2.0"))).toEqual({ ok: true });
    expect(await ledger.claim(claimReq("r1", "slack:C1:1.0"))).toEqual({ ok: true });
  });

  // docs/reference/specs/run-history.md item 48: the key a coordinator's spawn
  // carried is stored on the row at claim and named by the refusal a second
  // claim on the thread meets.
  it("a claim whose meta carries a coordinator's key stores it on the row, and a second claim on the thread is refused naming that key", async () => {
    const ledger = new InMemoryRunLedger(() => 0);
    const req = claimReq("r1", "slack:C1:1.0");
    await ledger.claim({
      ...req,
      meta: { ...req.meta, parentInstanceId: "ship_acme_1", idempotencyKey: "ship_acme_1:u/0/coding" },
    });
    expect(ledger.live.get("r1")?.meta).toMatchObject({
      parentInstanceId: "ship_acme_1",
      idempotencyKey: "ship_acme_1:u/0/coding",
    });
    expect(await ledger.claim(claimReq("r2", "slack:C1:1.0"))).toEqual({
      ok: false,
      reason: "thread-live",
      live: { runId: "r1", agent: "review", startedAt: 1_000, idempotencyKey: "ship_acme_1:u/0/coding" },
    });
  });

  it("every owner write is fenced: another generation's step, append, state, finishing and finish answer fenced; an unknown run is named", async () => {
    const ledger = new InMemoryRunLedger(() => 0);
    await ledger.claim(claimReq("r1", "slack:C1:1.0"));
    const fenced = { ok: false, reason: "fenced" };
    expect(await ledger.step("r1", "g2", stepRecord(1, 2), [])).toEqual(fenced);
    expect(await ledger.append("r1", "g2", [])).toEqual(fenced);
    expect(await ledger.setState("r1", "g2", {})).toEqual(fenced);
    expect(await ledger.finishing("r1", "g2")).toEqual(fenced);
    expect(await ledger.finish("r1", "g2", record("r1"))).toEqual(fenced);
    expect(await ledger.heartbeat("r1", "g2", 1_000)).toEqual(fenced);
    expect(await ledger.append("nope", "g1", [])).toEqual({ ok: false, reason: "unknown-run" });
  });

  it("heartbeat extends the lease and reports a stop another generation requested; requestStop says whether the owner is live", async () => {
    let t = 0;
    const ledger = new InMemoryRunLedger(() => t);
    await ledger.claim(claimReq("r1", "slack:C1:1.0"));
    expect(await ledger.requestStop("r1", "soft")).toEqual({ ok: true, ownerLive: true });
    t = 5_000;
    expect(await ledger.heartbeat("r1", "g1", LEASE_MS)).toEqual({ ok: true, stop: "soft", phase: "live" });
    expect((await ledger.listLive())[0].leaseUntil).toBe(5_000 + LEASE_MS);
    t = 100_000;
    expect(await ledger.requestStop("r1", "hard")).toEqual({ ok: true, ownerLive: false });
    expect(await ledger.requestStop("nope", "hard")).toEqual({ ok: false });
  });

  it("a run reserved `attaching` at admission (item 42) holds the thread with its request and no prompt; the owner's claim with the prompt promotes it to live in place (card, prompt, tools, state land; identity and start stay); another run on the thread is refused meanwhile; a reclaim of an expired attaching row keeps the phase and hands the request back", async () => {
    let t = 0;
    const ledger = new InMemoryRunLedger(() => t);
    const request = {
      channelId: "slack:C1",
      userId: "slack:UA",
      threadKey: "slack:C1:1.0",
      text: "review it",
      at: 900,
    };
    const reserve: ClaimRequest = {
      ...claimReq("r1", "slack:C1:1.0"),
      phase: "attaching",
      system: "",
      tools: [],
      card: null,
      meta: { agent: "review", channelId: "slack:C1", userId: "slack:UA", threadKey: "slack:C1:1.0", request },
    };
    expect(await ledger.claim(reserve)).toEqual({ ok: true });
    expect(ledger.live.get("r1")).toMatchObject({ phase: "attaching", system: "", tools: [], card: null });
    expect(ledger.live.get("r1")?.meta.request).toEqual(request);
    expect(await ledger.claim(claimReq("r2", "slack:C1:1.0"))).toMatchObject({ ok: false, reason: "thread-live" });
    // A re-reserve (a retry after a lost response) only refreshes the lease.
    t = 5_000;
    expect(await ledger.claim(reserve)).toEqual({ ok: true });
    expect(ledger.live.get("r1")).toMatchObject({ phase: "attaching", leaseUntil: 5_000 + LEASE_MS });
    // The prompt lands: the same claim the dispatcher always made, now a promotion.
    expect(await ledger.claim({ ...claimReq("r1", "slack:C1:1.0"), state: { checklist: [] } })).toEqual({ ok: true });
    expect(ledger.live.get("r1")).toMatchObject({
      phase: "live",
      system: "you are a reviewer",
      card: { channel: "C1", ts: "1.0" },
      state: { checklist: [] },
      startedAt: 1_000,
    });
    expect(ledger.live.get("r1")?.tools.map((x) => x.name)).toEqual(["bash"]);
    // A re-claim on the live row changes nothing (idempotent, as before).
    expect(await ledger.claim({ ...claimReq("r1", "slack:C1:1.0"), system: "other" })).toEqual({ ok: true });
    expect(ledger.live.get("r1")?.system).toBe("you are a reviewer");
    // A reserved run whose owner died: the reclaim keeps `attaching` so the launcher knows to restart it.
    await ledger.claim({
      ...reserve,
      runId: "r9",
      threadKey: "slack:C1:9.0",
      meta: { ...reserve.meta, threadKey: "slack:C1:9.0" },
    });
    await ledger.pushInbox("r9", { text: "also this" });
    t = 5_000 + LEASE_MS + 1;
    const taken = await ledger.reclaim("g2", t, LEASE_MS);
    const r9 = taken.find((r) => r.row.runId === "r9")!;
    expect(r9.reclaimedFrom).toBe("attaching");
    expect(r9.row).toMatchObject({ ownerGen: "g2", phase: "attaching" });
    expect(r9.row.meta.request).toEqual(request);
    expect(r9.inbox.map((i) => i.message.text)).toEqual(["also this"]);
    // The new generation promotes it when its own attach lands.
    expect(await ledger.claim({ ...claimReq("r9", "slack:C1:9.0", "g2") })).toEqual({ ok: true });
    expect(ledger.live.get("r9")).toMatchObject({ phase: "live", ownerGen: "g2" });
    // An attaching row can finish (a dispatch that fails before its prompt) but never be handed off.
    await ledger.claim({
      ...reserve,
      runId: "r5",
      threadKey: "slack:C1:5.0",
      meta: { ...reserve.meta, threadKey: "slack:C1:5.0" },
    });
    expect(await ledger.handoff("g1", ["r5"])).toEqual({ marked: [] });
    expect(await ledger.finishing("r5", "g1")).toEqual({ ok: true });
    // Abandon: the live rows go with no record — fenced like a finish.
    await ledger.claim({
      ...reserve,
      runId: "r6",
      threadKey: "slack:C1:6.0",
      meta: { ...reserve.meta, threadKey: "slack:C1:6.0" },
    });
    await ledger.pushInbox("r6", { text: "late" });
    expect(await ledger.abandon("r6", "g2")).toEqual({ ok: false, reason: "fenced" });
    expect(await ledger.abandon("r6", "g1")).toEqual({ ok: true });
    expect(ledger.live.get("r6")).toBeUndefined();
    expect(await ledger.readInbox("r6", 0)).toEqual([]);
    expect(ledger.finished.get("r6")).toBeUndefined();
    expect(await ledger.abandon("r6", "g1")).toEqual({ ok: false, reason: "unknown-run" });
  });

  it("reclaim takes the expired and handed-off runs, gives them to the new generation with the last step, the unconsumed inbox and the jobs, and re-fences the transcript", async () => {
    let t = 0;
    const ledger = new InMemoryRunLedger(() => t);
    await ledger.claim(claimReq("expired", "slack:C1:1.0"));
    await ledger.claim(claimReq("handed", "slack:C1:2.0"));
    await ledger.claim(claimReq("alive", "slack:C1:3.0"));
    // Our own row (g2's) with a lapsed lease: a heartbeat that did not land, never taken by our own sweep.
    await ledger.claim(claimReq("mine", "slack:C1:4.0", "g2"));
    await ledger.step("expired", "g1", { ...stepRecord(1, 2), inboxConsumedSeq: 1 }, []);
    await ledger.pushInbox("expired", { text: "first" });
    await ledger.pushInbox("expired", { text: "second" });
    await ledger.handoff("g1", ["handed"]);
    t = 20_000;
    await ledger.heartbeat("alive", "g1", LEASE_MS); // alive until 50 000
    t = 40_000;
    const taken = await ledger.reclaim("g2", t, LEASE_MS);
    expect(taken.map((r) => r.row.runId).sort()).toEqual(["expired", "handed"]);
    const expired = taken.find((r) => r.row.runId === "expired")!;
    expect(expired.row).toMatchObject({ ownerGen: "g2", phase: "live", leaseUntil: 40_000 + LEASE_MS });
    expect(expired.lastStep?.step).toBe(1);
    expect(expired.inbox.map((i) => i.message.text)).toEqual(["second"]);
    // The same slice on demand (item 40): what landed past a seq, any generation; nothing for an unknown run.
    expect((await ledger.readInbox("expired", 1)).map((i) => i.message.text)).toEqual(["second"]);
    expect((await ledger.readInbox("expired", 0)).map((i) => i.seq)).toEqual([1, 2]);
    expect(await ledger.readInbox("nope", 0)).toEqual([]);
    // Where each row came from: an expired lease was `live`, the drained one `handoff`.
    expect(expired.reclaimedFrom).toBe("live");
    expect(taken.find((r) => r.row.runId === "handed")!.reclaimedFrom).toBe("handoff");
    // The old generation is fenced everywhere, transcript included; the new one owns it.
    expect(await ledger.step("expired", "g1", stepRecord(2, 4), [])).toEqual({ ok: false, reason: "fenced" });
    expect(await ledger.seed("expired", "g1", [])).toEqual({ ok: false, reason: "fenced" });
    expect(await ledger.step("expired", "g2", stepRecord(2, 2), [])).toEqual({ ok: true });
    expect((await ledger.listLive()).find((r) => r.runId === "alive")?.ownerGen).toBe("g1");
    expect(ledger.live.get("mine")).toMatchObject({ ownerGen: "g2", phase: "live", leaseUntil: 0 + LEASE_MS }); // untouched
  });

  it("handoff marks only this generation's live runs; finishing cannot be handed off; a reclaimed finishing run comes back live", async () => {
    let t = 0;
    const ledger = new InMemoryRunLedger(() => t);
    await ledger.claim(claimReq("a", "slack:C1:1.0", "g1"));
    await ledger.claim(claimReq("b", "slack:C1:2.0", "g2"));
    await ledger.finishing("a", "g1");
    expect(await ledger.handoff("g1", ["a", "b"])).toEqual({ marked: [] });
    t = 100_000;
    const taken = await ledger.reclaim("g3", t, LEASE_MS);
    expect(taken.map((r) => [r.row.runId, r.row.phase]).sort()).toEqual([
      ["a", "live"],
      ["b", "live"],
    ]);
  });

  // docs/reference/specs/session-log.md items 1–4: the session log in the plainest
  // form — the same owner fence and (idx, part) upsert as the transcript, kept
  // across finishes, read by range and by tail.
  it("session log: the tail of an empty log is 0; a write before the owner is unknown-run; the owner appends at log indices and another generation is fenced; a range read re-bases; the tail read cuts at a turn boundary; finish releases the owner and clears nothing", async () => {
    const ledger = new InMemoryRunLedger(() => 10_000);
    const key = "slack:C1:1.0:review";
    expect(await ledger.sessionTail(key)).toBe(0);
    expect(await ledger.seed("r1", "g1", [{ idx: 0, message: seedTurns[0] }], key)).toEqual({
      ok: false,
      reason: "unknown-run",
    });
    await ledger.claim({
      ...claimReq("r1", "slack:C1:1.0"),
      meta: { ...claimReq("r1", "slack:C1:1.0").meta, session: { key, seedFrom: 0, request: 0, range: { from: 0 } } },
    });
    await ledger.claimSession(key, "r1", "g1");
    expect(
      await ledger.seed(
        "r1",
        "g1",
        seedTurns.map((message, idx) => ({ idx, message })),
        key,
      ),
    ).toEqual({ ok: true });
    expect(await ledger.step("r1", "g2", stepRecord(1, 3), [{ idx: 2, message: seedTurns[1] }], key)).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(await ledger.step("r1", "g1", stepRecord(1, 3), [{ idx: 2, message: seedTurns[1] }], key)).toEqual({
      ok: true,
    });
    expect(await ledger.sessionTail(key)).toBe(3);
    expect((await ledger.readSession(key, 1)).messages).toEqual([seedTurns[1], seedTurns[1]]);
    expect((await ledger.readSession(key, 0, 0)).messages).toEqual([seedTurns[0]]);
    const tail = await ledger.readSessionTail(key, 10_000);
    expect(tail.from).toBe(0);
    expect(tail.transcript.messages).toHaveLength(3);
    const one = await ledger.readSessionTail(key, 80);
    expect(one.from).toBe(2);
    expect(one.transcript.messages).toEqual([seedTurns[1]]);
    expect(await ledger.readSessionTail(key, 1)).toMatchObject({ from: 3, transcript: { turns: 0 } });
    // The run's own object was never written.
    expect((await ledger.readTranscript("r1")).turns).toBe(0);
    await ledger.finish("r1", "g1", {
      ...record("r1"),
      session: { key, seedFrom: 0, request: 0, range: { from: 0, to: 2 } },
    });
    expect(ledger.sessions.get(key)?.owner).toBeUndefined();
    expect((await ledger.readSession(key, 0)).messages).toHaveLength(3);
    expect(await ledger.seed("r1", "g1", [{ idx: 3, message: seedTurns[0] }], key)).toEqual({
      ok: false,
      reason: "unknown-run",
    });
    // A reclaim re-owns the session of a row that names one.
    await ledger.claim({
      ...claimReq("r2", "slack:C1:1.0"),
      meta: { ...claimReq("r2", "slack:C1:1.0").meta, session: { key, seedFrom: 3, request: 3, range: { from: 3 } } },
    });
    await ledger.claimSession(key, "r2", "g1");
    await ledger.reclaim("g3", 100_000, LEASE_MS);
    expect(ledger.sessions.get(key)?.owner).toEqual({ runId: "r2", gen: "g3" });
    expect(await ledger.releaseSession(key, "r2", "g1")).toEqual({ ok: false, reason: "fenced" });
    expect(await ledger.releaseSession(key, "r2", "g3")).toEqual({ ok: true });
  });

  // docs/reference/specs/session-log.md item 5: the reference ledger enforces the
  // byte policy the object enforces, so the two implementations agree.
  it("session log byte policy: over the budget carried on the claim, the oldest tool results are replaced by the marker first and their sole attachments reclaimed; user and assistant text is never dropped", async () => {
    const ledger = new InMemoryRunLedger(() => 10_000);
    const key = "slack:C1:1.0:coding";
    const text = (role: "user" | "assistant", t: string): ChatMessage => ({
      role,
      content: [{ type: "text", text: t }],
    });
    const result = (callId: string, t: string): ChatMessage => ({
      role: "user",
      content: [{ type: "tool_result", toolUseId: callId, content: t }],
    });
    await ledger.claimSession(key, "r1", "g1", 2000);
    await ledger.seed(
      "r1",
      "g1",
      [
        text("user", "please run the tests"),
        text("assistant", "running"),
        result("c1", "A".repeat(1200)),
        text("assistant", "again"),
        result("c2", "B".repeat(1200)),
      ].map((message, idx) => ({ idx, message })),
      key,
    );
    const { messages } = await ledger.readSession(key, 0);
    expect(messages[0]).toEqual(text("user", "please run the tests"));
    expect(messages[1]).toEqual(text("assistant", "running"));
    expect(messages[2].content[0]).toMatchObject({ type: "tool_result", toolUseId: "c1" });
    expect(String((messages[2].content[0] as { content: unknown }).content)).toMatch(/dropped/);
    expect(messages[3]).toEqual(text("assistant", "again"));
    expect(messages[4]).toEqual(result("c2", "B".repeat(1200)));
    expect(ledger.sessionBytes(key)).toBeLessThanOrEqual(2000);

    // Text alone over the budget: nothing more is dropped.
    const textOnly = "slack:C1:2.0:coding";
    await ledger.claimSession(textOnly, "r2", "g1", 200);
    await ledger.seed(
      "r2",
      "g1",
      [text("user", "u".repeat(300)), text("assistant", "a".repeat(300))].map((message, idx) => ({ idx, message })),
      textOnly,
    );
    expect(
      (await ledger.readSession(textOnly, 0)).messages.map((m) => (m.content[0] as { text: string }).text.length),
    ).toEqual([300, 300]);

    // An externalized image on a user turn is never a candidate: it and its attachment stay.
    const withImage = "slack:C1:3.0:coding";
    await ledger.claimSession(withImage, "r3", "g1", 2500);
    const big = "A".repeat(ATTACHMENT_REF_BYTES + 1);
    await ledger.seed(
      "r3",
      "g1",
      [
        text("user", "look"),
        { role: "user", content: [{ type: "image", mediaType: "image/png", data: big }] } as ChatMessage,
        text("assistant", "seen"),
      ].map((message, idx) => ({ idx, message })),
      withImage,
    );
    // The user's own image is never dropped, so the log rests over budget with the attachment kept.
    expect(ledger.sessions.get(withImage)!.attachments.map((a) => a.ref)).toEqual(["t1p0"]);
    expect((await ledger.readSession(withImage, 1, 1)).messages[0].content[0]).toMatchObject({
      type: "image",
      data: big,
    });

    // The budget defaults when the claim carries none.
    await ledger.claimSession("slack:C1:4.0:coding", "r4", "g1");
    expect(ledger.sessions.get("slack:C1:4.0:coding")!.maxBytes).toBe(DEFAULT_SESSION_LOG_MAX_BYTES);
  });

  // docs/reference/specs/session-log.md item 10: what `recall` and `notes` read and write.
  it("the search answers hits in relevance order with turn, role and kind, names the gap markers between them, and nothing for a wordless query or an unknown log; the notepad is written whole under the owner's fence and read back", async () => {
    const ledger = new InMemoryRunLedger(() => 7_000);
    const key = "slack:C1:9.0:coding";
    const say = (text: string): ChatMessage => ({ role: "user", content: [{ type: "text", text }] });
    const reply = (text: string): ChatMessage => ({ role: "assistant", content: [{ type: "text", text }] });
    const failed: ChatMessage = {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "c1", content: "1 failed: lockfile.test.ts" }],
    };
    await ledger.claimSession(key, "r1", "g1");
    await ledger.seed(
      "r1",
      "g1",
      [
        say("please fix the flaky lockfile test"),
        reply("the lockfile is fine"),
        say(GAP_MARKER),
        failed,
        say("unrelated remark"),
      ].map((message, idx) => ({ idx, message })),
      key,
    );
    const found = await ledger.searchSession(key, "flaky lockfile", 5);
    expect(found.hits[0]).toMatchObject({ idx: 0, role: "user", kind: "text" });
    expect(found.hits.slice(1).map((h) => [h.idx, h.role, h.kind])).toEqual([
      [3, "user", "tool_result"],
      [1, "assistant", "text"],
    ]);
    expect(found.gaps).toEqual([2]);
    expect(await ledger.searchSession(key, "unrelated", 5)).toMatchObject({ hits: [{ idx: 4 }], gaps: [] });
    expect((await ledger.searchSession(key, "flaky lockfile", 1)).hits).toHaveLength(1);
    expect(await ledger.searchSession(key, "   ", 5)).toEqual({ hits: [], gaps: [] });
    expect(await ledger.searchSession("slack:C1:none:coding", "flaky", 5)).toEqual({ hits: [], gaps: [] });
    expect(await ledger.readNotepad(key)).toBeNull();
    expect(await ledger.writeNotepad("slack:C1:none:coding", "g1", "x")).toEqual({ ok: false, reason: "unknown-run" });
    expect(await ledger.writeNotepad(key, "g2", "zombie")).toEqual({ ok: false, reason: "fenced" });
    expect(await ledger.writeNotepad(key, "g1", "decided: keep the helper")).toEqual({ ok: true });
    expect(await ledger.readNotepad(key)).toEqual({ text: "decided: keep the helper", updatedAt: 7_000 });
  });
});
