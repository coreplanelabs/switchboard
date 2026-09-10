import { describe, expect, it, vi } from "vitest";
import { createReviewAbridge, MAX_POLLS } from "./reviewAbridge";

// Feature: docs/reference/specs/reading-diff.md item 12 — the host's half of the panel's
// "Abridge with meat" control: one POST starts (or resumes) the abridging, the
// same POST is the poll, and `done` is read off the run's record, whose
// review_artifact frames go to the collector like any other frame.

type Reply = { status: number; body: unknown };
const json = (body: unknown, status = 200): Reply => ({ status, body });

/** A fetch fake answering scripted replies in order, recording every call. */
function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = replies.shift();
    if (!r) throw new Error(`unscripted fetch ${url}`);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const meatArtifact = {
  type: "review_artifact",
  artifact: "reading_diff",
  poweredBy: "meat",
  baseRef: "main",
  diff: "diff --git a/f b/f\n+x",
  truncated: false,
  seq: 9,
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createReviewAbridge", () => {
  it("start: POSTs the run id as JSON same-origin, reads running, polls with the same POST after a delay, and on done pages the record and hands every event to the sink", async () => {
    const { fetch, calls } = fakeFetch([
      json({ id: "run-1", state: "running", startedAt: 1 }),
      json({ id: "run-1", state: "done", reused: false, artifact: { model: "m" } }),
      json({ events: [{ type: "run_meta", agent: "review" }], nextAfterSeq: 5 }),
      json({ events: [meatArtifact] }),
    ]);
    const delay = vi.fn(async () => {});
    const sink = vi.fn();
    const a = createReviewAbridge("run-1", sink, { fetch, delay });
    expect(a.state).toEqual({ state: "absent" });
    a.start();
    expect(a.state).toEqual({ state: "running" });
    await flush();
    expect(a.state).toEqual({ state: "done" });
    expect(calls[0].url).toBe("/api/review.abridge");
    expect(calls[0].init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ id: "run-1" });
    expect(delay).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ id: "run-1" });
    expect(calls[2].url).toBe("/api/runs.events?id=run-1");
    expect(calls[2].init).toMatchObject({ credentials: "same-origin" });
    expect(calls[3].url).toBe("/api/runs.events?id=run-1&after-seq=5");
    expect(sink.mock.calls.map((c) => c[0])).toEqual([{ type: "run_meta", agent: "review" }, meatArtifact]);
  });

  it("done straight away (a stored one is reused) skips the poll; done with no meat artifact on the record is a failure that names it", async () => {
    const reused = fakeFetch([json({ id: "run-1", state: "done", reused: true }), json({ events: [meatArtifact] })]);
    const a = createReviewAbridge("run-1", vi.fn(), { fetch: reused.fetch, delay: vi.fn(async () => {}) });
    a.start();
    await flush();
    expect(a.state).toEqual({ state: "done" });
    expect(reused.calls).toHaveLength(2);

    const empty = fakeFetch([json({ id: "run-1", state: "done" }), json({ events: [{ type: "answer", text: "x" }] })]);
    const b = createReviewAbridge("run-1", vi.fn(), { fetch: empty.fetch, delay: vi.fn(async () => {}) });
    b.start();
    await flush();
    expect(b.state).toEqual({ state: "failed", reason: "the abridged diff did not appear on the run's record" });
  });

  it("failed carries the reason; a retry after a failure sends force: true", async () => {
    const { fetch, calls } = fakeFetch([
      json({ id: "run-1", state: "failed", reason: "meat exited 1: no credential", at: 2 }),
      json({ id: "run-1", state: "running", startedAt: 3 }),
    ]);
    const a = createReviewAbridge("run-1", vi.fn(), { fetch, delay: () => new Promise(() => {}) });
    a.start();
    await flush();
    expect(a.state).toEqual({ state: "failed", reason: "meat exited 1: no credential" });
    a.start();
    expect(a.state).toEqual({ state: "running" });
    await flush();
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ id: "run-1", force: true });
  });

  it("a non-2xx answer fails with the body's error (else the status); a thrown fetch fails with its message; an unknown state fails too", async () => {
    const refused = fakeFetch([json({ error: "run has no reading diff", code: "conflict" }, 409)]);
    const a = createReviewAbridge("run-1", vi.fn(), { fetch: refused.fetch, delay: vi.fn(async () => {}) });
    a.start();
    await flush();
    expect(a.state).toEqual({ state: "failed", reason: "run has no reading diff" });

    const bare = fakeFetch([{ status: 503, body: null }]);
    const b = createReviewAbridge("run-1", vi.fn(), { fetch: bare.fetch, delay: vi.fn(async () => {}) });
    b.start();
    await flush();
    expect(b.state).toEqual({ state: "failed", reason: "HTTP 503" });

    const thrown = createReviewAbridge("run-1", vi.fn(), {
      fetch: (async () => {
        throw new Error("network down");
      }) as unknown as typeof globalThis.fetch,
      delay: vi.fn(async () => {}),
    });
    thrown.start();
    await flush();
    expect(thrown.state).toEqual({ state: "failed", reason: "network down" });

    const odd = fakeFetch([json({ id: "run-1", state: "sideways" })]);
    const c = createReviewAbridge("run-1", vi.fn(), { fetch: odd.fetch, delay: vi.fn(async () => {}) });
    c.start();
    await flush();
    expect(c.state).toEqual({ state: "failed", reason: "unexpected answer: sideways" });
  });

  it("start while running is a no-op; dispose stops the polling; the poll gives up after MAX_POLLS rounds", async () => {
    const running = json({ id: "run-1", state: "running", startedAt: 1 });
    const { fetch, calls } = fakeFetch(Array.from({ length: MAX_POLLS + 5 }, () => ({ ...running })));
    let release: (() => void) | undefined;
    const delay = vi.fn(() => new Promise<void>((r) => (release = r)));
    const a = createReviewAbridge("run-1", vi.fn(), { fetch, delay });
    a.start();
    a.start();
    await flush();
    expect(calls).toHaveLength(1);
    a.dispose();
    release?.();
    await flush();
    expect(calls).toHaveLength(1); // no poll after dispose
    expect(a.state).toEqual({ state: "running" }); // whatever it was; the page is gone

    const gives = fakeFetch(Array.from({ length: MAX_POLLS + 5 }, () => ({ ...running })));
    const b = createReviewAbridge("run-1", vi.fn(), { fetch: gives.fetch, delay: vi.fn(async () => {}) });
    b.start();
    await flush();
    expect(gives.calls).toHaveLength(MAX_POLLS + 1);
    expect(b.state).toEqual({
      state: "failed",
      reason: "still running after the page stopped waiting; ask again later",
    });
  });
});
