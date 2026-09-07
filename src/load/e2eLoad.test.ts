import { describe, expect, it } from "vitest";
import { summarize } from "./aggregate.js";
import { e2eThreadFor, runE2eLoad } from "./e2eLoad.js";

// `load:e2e` against a stubbed bot (features/load-harness.md item 10): each
// thread posts one synchronous ingress request per iteration and records the
// run receipt's status; /healthz is sampled alongside.

function stubBot(opts: { failEvery?: number } = {}) {
  const posts: Array<{ url: string; body: Record<string, unknown>; auth: string | undefined }> = [];
  let n = 0;
  let t = 0;
  const now = () => t;
  const sleep = async (ms: number) => {
    t += ms;
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/healthz")) {
      return new Response(
        JSON.stringify({
          ok: true,
          inFlight: posts.length,
          process: { rssMb: 210, heapUsedMb: 80, eventLoopLagP99Ms: 12 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    const headers = new Headers(init?.headers);
    posts.push({
      url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      auth: headers.get("authorization") ?? undefined,
    });
    n++;
    t += 2_000;
    if (opts.failEvery && n % opts.failEvery === 0) {
      return new Response(JSON.stringify({ reply: "boom", run: { id: `run-${n}`, status: "failed" } }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ reply: "ok", run: { id: `run-${n}`, status: "completed" } }), { status: 200 });
  };
  return { posts, now, sleep, fetch: fetchImpl };
}

describe("runE2eLoad", () => {
  it("posts one synchronous ingress request per iteration with the bearer, the text, and a per-thread thread key; records completed runs as ok", async () => {
    const bot = stubBot();
    const out = await runE2eLoad(
      {
        runId: "e1",
        ingressUrl: "http://bot/ingress",
        token: "tok",
        text: "agent:coding in x/y: load",
        threads: 2,
        staggerMs: 0,
        holdMs: 3_000,
        healthzUrl: "http://bot/healthz",
        healthzEveryMs: 1_000,
      },
      bot,
    );
    expect(bot.posts.length).toBeGreaterThanOrEqual(2);
    expect(bot.posts[0]).toMatchObject({ url: "http://bot/ingress", auth: "Bearer tok" });
    expect(bot.posts[0].body).toEqual({
      text: "agent:coding in x/y: load",
      channel: "load",
      thread: e2eThreadFor("e1", 0),
    });
    expect(bot.posts[0].body).not.toHaveProperty("async");
    const s = summarize(out.samples);
    expect(s.ops[0]).toMatchObject({ op: "run", failed: 0 });
    expect(out.health.length).toBeGreaterThan(0);
    expect(out.health[0]).toMatchObject({ ok: true, rssMb: 210, heapUsedMb: 80, eventLoopLagP99Ms: 12 });
  });

  it("a run that finishes failed is a failed sample with the status as its reason; a transport error is `transport`", async () => {
    const bot = stubBot({ failEvery: 2 });
    const out = await runE2eLoad(
      { runId: "e2", ingressUrl: "http://bot/ingress", token: "t", text: "x", threads: 1, staggerMs: 0, holdMs: 4_000 },
      bot,
    );
    const s = summarize(out.samples);
    expect(s.refusals.failed).toBeGreaterThanOrEqual(1);
    const broken = await runE2eLoad(
      { runId: "e3", ingressUrl: "http://bot/ingress", token: "t", text: "x", threads: 1, staggerMs: 0, holdMs: 1 },
      {
        ...bot,
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
    );
    expect(summarize(broken.samples).refusals).toEqual({ transport: 1 });
    expect(broken.result.errors).toBe(0);
  });

  it("the run ends when the last thread does — the health sampler's sleep never adds its interval to the tail", async () => {
    // A timer-queue clock: sleeps resolve only when ticked in time order, so
    // the moment the run resolves tells whether it waited on the 60 s sampler
    // sleep (t ≥ 60 000) or ended with the threads (t ≈ 4 000).
    let t = 0;
    const timers: Array<{ at: number; resolve: () => void }> = [];
    const sleep = (ms: number) => new Promise<void>((resolve) => void timers.push({ at: t + ms, resolve }));
    let posts = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/healthz"))
        return new Response(JSON.stringify({ ok: true, inFlight: 0 }), { status: 200 });
      posts++;
      await sleep(2_000);
      return new Response(JSON.stringify({ reply: "ok", run: { id: `r${posts}`, status: "completed" } }), {
        status: 200,
      });
    };
    let settledAt: number | undefined;
    const run = runE2eLoad(
      {
        runId: "e5",
        ingressUrl: "http://bot/ingress",
        token: "t",
        text: "x",
        threads: 1,
        staggerMs: 0,
        holdMs: 3_000,
        healthzUrl: "http://bot/healthz",
        healthzEveryMs: 60_000,
      },
      { fetch: fetchImpl, now: () => t, sleep },
    ).then(() => {
      settledAt = t;
    });
    for (let i = 0; i < 100 && settledAt === undefined; i++) {
      for (let j = 0; j < 20; j++) await Promise.resolve();
      if (settledAt !== undefined) break;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (!next) break;
      t = Math.max(t, next.at);
      next.resolve();
    }
    await run;
    expect(settledAt).toBeDefined();
    expect(settledAt!).toBeLessThan(20_000);
  });

  it("a dead endpoint is not hammered: failed requests pause for failurePauseMs before the next attempt", async () => {
    const bot = stubBot();
    let attempts = 0;
    const out = await runE2eLoad(
      {
        runId: "e4",
        ingressUrl: "http://bot/ingress",
        token: "t",
        text: "x",
        threads: 1,
        staggerMs: 0,
        holdMs: 20_000,
        failurePauseMs: 5_000,
      },
      {
        ...bot,
        fetch: async () => {
          attempts++;
          throw new Error("ECONNREFUSED");
        },
      },
    );
    // 20 s of hold at a 5 s failure pause is four attempts, not thousands.
    expect(attempts).toBe(4);
    expect(out.samples).toHaveLength(4);
  });
});
