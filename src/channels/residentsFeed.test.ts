import { describe, expect, it } from "vitest";
import { RunRegistry } from "../core/runRegistry.js";
import type { RunEvent } from "../core/runEvents.js";
import type { SseSink } from "./liveView/sse.js";
import { ATTACH_SPAN, isAttachEnd, serveResidentsFeed, type ResidentsFeedSource } from "./residentsFeed.js";
import type { ResidentListing } from "./residentsModel.js";
import type { ResidentsFeedFrame } from "./webSeed.js";

// The residents feed over a REAL registry: which index events reach the page,
// which run events re-read the listing, how reads coalesce, and what a
// disconnect releases. The listing is a fake with a call log.

function fakeSink() {
  const chunks: string[] = [];
  let status = 0;
  let headers: Record<string, string> = {};
  let onClose: (() => void) | undefined;
  const sink: SseSink = {
    writeHead: (s, h) => {
      status = s;
      headers = h;
    },
    write: (c) => void chunks.push(c),
    end: () => undefined,
    onClose: (cb) => {
      onClose = cb;
    },
  };
  return {
    sink,
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
    /** Every `data:` frame parsed, in order (heartbeats and the prelude skipped). */
    frames: (): ResidentsFeedFrame[] =>
      chunks
        .join("")
        .split("\n\n")
        .filter((c) => c.startsWith("data: "))
        .map((c) => JSON.parse(c.slice("data: ".length)) as ResidentsFeedFrame),
    close: () => onClose?.(),
  };
}

const LISTING: ResidentListing = {
  cap: 5,
  count: 1,
  residents: [{ resource: "repo:acme/web", live: { state: "warm" } }],
};

/** A listing source whose reads the test resolves by hand, so coalescing is observable. */
function manualListing() {
  const pending: Array<(r: ResidentListing | { error: string }) => void> = [];
  return {
    pending,
    listing: () => new Promise<ResidentListing | { error: string }>((resolve) => pending.push(resolve)),
    /** Resolve the oldest in-flight read. */
    resolve: async (r: ResidentListing | { error: string } = LISTING) => {
      pending.shift()?.(r);
      await new Promise((tick) => setTimeout(tick, 0));
    },
  };
}

function sourceOver(registry: RunRegistry, listing: () => Promise<ResidentListing | { error: string }>) {
  const source: ResidentsFeedSource = {
    subscribeIndex: (onEvent) => registry.subscribeIndex(onEvent),
    subscribeRun: (id, token, opts) => registry.subscribe(id, token, opts),
    listing,
  };
  return source;
}

const attachEnd: RunEvent = {
  type: "span_end",
  spanId: "s1",
  name: ATTACH_SPAN,
  startedAt: 1,
  durationMs: 5,
  status: "ok",
};

const meta = (repo?: string) => ({
  channelId: "slack:C1",
  userId: "slack:UALICE",
  threadKey: "slack:C1:1.1",
  ...(repo ? { repo } : {}),
});

describe("isAttachEnd", () => {
  it("is the end of the dispatcher's attach span and nothing else", () => {
    expect(isAttachEnd(attachEnd)).toBe(true);
    expect(isAttachEnd({ ...attachEnd, type: "span_start" } as RunEvent)).toBe(false);
    expect(isAttachEnd({ ...attachEnd, name: "dispatch.workspace.attach.clone" })).toBe(false);
    expect(isAttachEnd({ type: "answer", text: "done" })).toBe(false);
  });
});

describe("serveResidentsFeed", () => {
  it("opens with the SSE head, replays the live repo runs as upserts and never a run without a repo", () => {
    const registry = new RunRegistry();
    const onRepo = registry.create("coding · acme/web", meta("acme/web"));
    registry.create("general · #dev", meta());
    const io = fakeSink();
    let liveCalls = 0;
    serveResidentsFeed(sourceOver(registry, manualListing().listing), io.sink, () => liveCalls++);
    expect(io.status).toBe(200);
    expect(io.headers["content-type"]).toContain("text/event-stream");
    expect(liveCalls).toBe(1);
    const frames = io.frames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "upsert", run: { id: onRepo.id, repo: "acme/web", finished: false } });
  });

  it("forwards a repo run's lifecycle live — create, finish, eviction — and drops a removed for a run it never showed", () => {
    const registry = new RunRegistry({ ttlMs: 0 });
    const io = fakeSink();
    serveResidentsFeed(sourceOver(registry, manualListing().listing), io.sink);
    const a = registry.create("coding · acme/web", meta("acme/web"));
    const b = registry.create("general · #dev", meta());
    registry.finish(a.id, "completed");
    registry.finish(b.id, "completed");
    registry.seal(a.id);
    registry.seal(b.id);
    // The sweep evicts finished runs past the TTL (0 here) on the next registry call.
    registry.listActive();
    const types = io
      .frames()
      .map((f) =>
        f.type === "upsert"
          ? `${f.type}:${f.run.id}:${f.run.finished}`
          : f.type === "removed"
            ? `${f.type}:${f.id}`
            : f.type,
      );
    // finish and seal each upsert the finished row (the seal adds its stamp); the sweep removes it.
    expect(types).toEqual([`upsert:${a.id}:false`, `upsert:${a.id}:true`, `upsert:${a.id}:true`, `removed:${a.id}`]);
  });

  it("re-reads the listing when a repo run's attach span ends and when its stream seals, pushing the listing whole", async () => {
    const registry = new RunRegistry();
    const reads = manualListing();
    const io = fakeSink();
    serveResidentsFeed(sourceOver(registry, reads.listing), io.sink);
    const run = registry.create("coding · acme/web", meta("acme/web"));
    expect(reads.pending).toHaveLength(0); // a create alone binds nothing
    registry.publish(run.id, { type: "span_start", spanId: "s1", name: ATTACH_SPAN, at: 1 });
    expect(reads.pending).toHaveLength(0);
    registry.publish(run.id, attachEnd);
    expect(reads.pending).toHaveLength(1);
    await reads.resolve({ ...LISTING, count: 1 });
    registry.publish(run.id, { type: "answer", text: "done" });
    expect(reads.pending).toHaveLength(0); // an ordinary event is not a signal
    registry.finish(run.id, "completed");
    expect(reads.pending).toHaveLength(0); // the tree is released after the reply, at the seal
    registry.seal(run.id);
    expect(reads.pending).toHaveLength(1);
    await reads.resolve(LISTING);
    const listings = io.frames().filter((f) => f.type === "residents");
    expect(listings).toEqual([
      { type: "residents", cap: 5, count: 1, residents: LISTING.residents },
      { type: "residents", cap: 5, count: 1, residents: LISTING.residents },
    ]);
  });

  it("coalesces reads: one in flight, at most one queued behind it — three signals during a read cost two reads", async () => {
    const registry = new RunRegistry();
    const reads = manualListing();
    const io = fakeSink();
    serveResidentsFeed(sourceOver(registry, reads.listing), io.sink);
    const runs = [1, 2, 3].map((i) =>
      registry.create(`coding · acme/web ${i}`, { ...meta("acme/web"), threadKey: `slack:C1:${i}` }),
    );
    for (const r of runs) registry.publish(r.id, attachEnd);
    expect(reads.pending).toHaveLength(1);
    await reads.resolve();
    expect(reads.pending).toHaveLength(1); // the one queued read, now in flight
    await reads.resolve();
    expect(reads.pending).toHaveLength(0);
    expect(io.frames().filter((f) => f.type === "residents")).toHaveLength(2);
  });

  it("a listing that fails sends nothing — the page keeps the listing it has", async () => {
    const registry = new RunRegistry();
    const reads = manualListing();
    const io = fakeSink();
    serveResidentsFeed(sourceOver(registry, reads.listing), io.sink);
    const run = registry.create("coding · acme/web", meta("acme/web"));
    registry.publish(run.id, attachEnd);
    await reads.resolve({ error: "resident Worker answered 502" });
    expect(io.frames().filter((f) => f.type === "residents")).toHaveLength(0);
    // and the next signal reads again
    registry.publish(run.id, attachEnd);
    expect(reads.pending).toHaveLength(1);
  });

  it("a disconnect releases the index subscription and every per-run watch; nothing is written after it", async () => {
    const registry = new RunRegistry();
    const reads = manualListing();
    const io = fakeSink();
    serveResidentsFeed(sourceOver(registry, reads.listing), io.sink);
    const run = registry.create("coding · acme/web", meta("acme/web"));
    registry.publish(run.id, attachEnd);
    const before = io.frames().length;
    io.close();
    registry.create("coding · acme/web again", { ...meta("acme/web"), threadKey: "slack:C1:2" });
    registry.publish(run.id, attachEnd);
    registry.seal(run.id);
    expect(reads.pending).toHaveLength(1); // the read that was in flight at the close; no new one
    await reads.resolve();
    expect(io.frames().length).toBe(before);
  });
});
