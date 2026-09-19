import { describe, expect, it } from "vitest";
import { postPlaneDeploy, type PlaneDeployDeps } from "./planeDeploy.js";

// The pending-deploy window (record 0064, "The queue"): `deploy all` posts
// `pending` before the bot rolls and `landed` after the run — landed or
// failed alike — so `deploy_settled` flips end-to-end and a queued ask is
// admitted. Best-effort: nothing here ever fails the deploy.

function harness(over: Partial<PlaneDeployDeps> = {}) {
  const posts: { url: string; init: RequestInit }[] = [];
  const lines: string[] = [];
  let answer: () => Response = () => new Response(JSON.stringify({ ok: true, admitted: 2 }), { status: 200 });
  const deps: PlaneDeployDeps = {
    stateWorkerUrl: "https://memory.example/",
    env: { MEMORY_TOKEN: "memory-token" },
    log: (l) => void lines.push(l),
    fetchFn: async (url, init) => {
      posts.push({ url, init });
      return answer();
    },
    ...over,
  };
  return { deps, posts, lines, setAnswer: (fn: () => Response) => void (answer = fn) };
}

describe("postPlaneDeploy — the /plane/deploy post from the deploy runner", () => {
  it("posts pending and landed to the state Worker's /plane/deploy with the bearer, the store key and the commit; landed logs how many asks were admitted", async () => {
    const h = harness();
    await postPlaneDeploy(h.deps, "pending", "abc1234def");
    await postPlaneDeploy(h.deps, "landed", "abc1234def");
    expect(h.posts.map((p) => p.url)).toEqual([
      "https://memory.example/plane/deploy",
      "https://memory.example/plane/deploy",
    ]);
    expect((h.posts[0].init.headers as Record<string, string>).authorization).toBe("Bearer memory-token");
    expect(JSON.parse(h.posts[0].init.body as string)).toEqual({
      storeKey: "runs:default",
      phase: "pending",
      version: "abc1234def",
    });
    expect(JSON.parse(h.posts[1].init.body as string)).toMatchObject({ phase: "landed" });
    expect(h.lines[0]).toContain("deploy pending posted");
    expect(h.lines[1]).toContain("2 queued ask(s) admitted");
  });

  it("no state Worker posts nothing; a missing bearer is one line and nothing is sent", async () => {
    const none = harness({ stateWorkerUrl: undefined });
    await postPlaneDeploy(none.deps, "pending", "abc1234def");
    expect(none.posts).toEqual([]);
    expect(none.lines).toEqual([]);
    const noToken = harness({ env: {} });
    await postPlaneDeploy(noToken.deps, "landed", "abc1234def");
    expect(noToken.posts).toEqual([]);
    expect(noToken.lines[0]).toContain("MEMORY_TOKEN is not set");
  });

  it("an older state Worker (404) and an unreachable one (throw) are one line each — the deploy is never failed by the plane", async () => {
    const older = harness();
    older.setAnswer(() => new Response("not found", { status: 404 }));
    await postPlaneDeploy(older.deps, "landed", "abc1234def");
    expect(older.lines[0]).toContain("not recorded (404)");
    const down = harness({
      fetchFn: async () => {
        throw new Error("connect refused");
      },
    });
    await postPlaneDeploy(down.deps, "pending", "abc1234def");
    expect(down.lines[0]).toContain("not recorded (connect refused)");
  });
});
