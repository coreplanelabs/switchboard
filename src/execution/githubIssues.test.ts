import { describe, expect, it } from "vitest";
import { GithubIssueTracker, InMemoryIssueTracker } from "./githubIssues.js";

// Feature: docs/reference/specs/self-improvement.md — the IssueTracker seam behind the
// friction proposer. GithubIssueTracker speaks the GitHub REST API from the bot
// process with the App installation token (AGENTS.md invariant 5: never a `gh`
// shell-out); InMemoryIssueTracker is the second implementation (invariant 2)
// and the test double.

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function fakeFetch(routes: (call: Call) => { status: number; body?: unknown } | undefined) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const r = routes({ url, method, body }) ?? { status: 404, body: { message: "Not Found" } };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const tokenOk = async () => "tok-123";

describe("GithubIssueTracker.listOpen", () => {
  it("lists open issues with the label (paginated) plus the newest unfiltered ones, deduped, dropping pull requests", async () => {
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        number: i,
        title: `t${i}`,
        body: `b${i}`,
        html_url: `https://gh/o/r/issues/${i}`,
      }));
    const { fetch, calls } = fakeFetch(({ url }) => {
      if (url.endsWith("&page=1")) return { status: 200, body: [...page(100)] };
      if (url.endsWith("&page=2")) {
        return {
          status: 200,
          body: [
            { number: 900, title: "a PR", body: "x", html_url: "https://gh/o/r/pull/900", pull_request: {} },
            { number: 901, title: "issue", body: null, html_url: "https://gh/o/r/issues/901" },
          ],
        };
      }
      if (url.includes("sort=created")) {
        // The label index lags creation: the freshest proposal is only here.
        return {
          status: 200,
          body: [
            {
              number: 902,
              title: "fresh",
              body: "<!-- switchboard-friction-pattern: x -->",
              html_url: "https://gh/o/r/issues/902",
            },
            { number: 901, title: "issue", body: null, html_url: "https://gh/o/r/issues/901" }, // overlap → once
          ],
        };
      }
      return undefined;
    });
    const tracker = new GithubIssueTracker({ fetch, token: tokenOk });
    const issues = await tracker.listOpen("o/r", "self-improvement");
    expect(issues).toHaveLength(102);
    expect(issues.find((i) => i.number === 901)).toEqual({
      number: 901,
      title: "issue",
      body: "",
      url: "https://gh/o/r/issues/901",
    });
    expect(issues.find((i) => i.number === 902)?.title).toBe("fresh");
    expect(calls.map((c) => c.url.replace("https://api.github.com/repos/o/r/issues?", ""))).toEqual([
      "state=open&labels=self-improvement&per_page=100&page=1",
      "state=open&labels=self-improvement&per_page=100&page=2", // a short page ends pagination
      "state=open&sort=created&direction=desc&per_page=30",
    ]);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("redacts a credential in the failure body before slicing it into the error (item 62)", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 403,
      body: { message: "denied GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
    }));
    const tracker = new GithubIssueTracker({ fetch, token: tokenOk });
    const err = await tracker.listOpen("o/r", "x").catch((e: unknown) => e);
    expect((err as Error).message).toContain("HTTP 403");
    expect((err as Error).message).not.toContain("ghp_");
  });

  it("throws with the HTTP status on a non-2xx so the caller can report it", async () => {
    const { fetch } = fakeFetch(() => ({ status: 403, body: { message: "Resource not accessible by integration" } }));
    const tracker = new GithubIssueTracker({ fetch, token: tokenOk });
    await expect(tracker.listOpen("o/r", "x")).rejects.toThrow(/HTTP 403.*Resource not accessible/);
  });

  it("throws when no GitHub credential is available", async () => {
    const { fetch, calls } = fakeFetch(() => undefined);
    const tracker = new GithubIssueTracker({ fetch, token: async () => null });
    await expect(tracker.listOpen("o/r", "x")).rejects.toThrow(/no GitHub credential/);
    expect(calls).toEqual([]);
  });
});

describe("GithubIssueTracker.create", () => {
  it("ensures the label exists (creating it once when missing), then opens the issue", async () => {
    let labelExists = false;
    const { fetch, calls } = fakeFetch(({ url, method }) => {
      if (url.endsWith("/labels/self-improvement") && method === "GET")
        return labelExists ? { status: 200, body: {} } : { status: 404 };
      if (url.endsWith("/labels") && method === "POST") {
        labelExists = true;
        return { status: 201, body: {} };
      }
      if (url.endsWith("/issues") && method === "POST") {
        return { status: 201, body: { number: 42, title: "T", body: "B", html_url: "https://gh/o/r/issues/42" } };
      }
      return undefined;
    });
    const tracker = new GithubIssueTracker({ fetch, token: tokenOk });
    const issue = await tracker.create("o/r", { title: "T", body: "B", labels: ["self-improvement"] });
    expect(issue).toEqual({ number: 42, title: "T", body: "B", url: "https://gh/o/r/issues/42" });
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://api.github.com/repos/o/r", "")}`)).toEqual([
      "GET /labels/self-improvement",
      "POST /labels",
      "POST /issues",
    ]);
    expect(calls[1].body).toMatchObject({ name: "self-improvement" });
    expect(calls[2].body).toEqual({ title: "T", body: "B", labels: ["self-improvement"] });

    // Second create: the label is cached — no lookup, no create.
    await tracker.create("o/r", { title: "T2", body: "B2", labels: ["self-improvement"] });
    expect(calls.filter((c) => c.url.includes("/labels")).length).toBe(2);
  });

  it("a label create that races (422 already exists) is not an error", async () => {
    const { fetch } = fakeFetch(({ url, method }) => {
      if (url.includes("/labels/") && method === "GET") return { status: 404 };
      if (url.endsWith("/labels")) return { status: 422, body: { errors: [{ code: "already_exists" }] } };
      if (url.endsWith("/issues")) return { status: 201, body: { number: 1, title: "T", body: "B", html_url: "u" } };
      return undefined;
    });
    const tracker = new GithubIssueTracker({ fetch, token: tokenOk });
    await expect(tracker.create("o/r", { title: "T", body: "B", labels: ["l"] })).resolves.toMatchObject({ number: 1 });
  });

  it("sends the App token as a bearer and the switchboard user-agent", async () => {
    const seen: Array<Record<string, string>> = [];
    const impl = (async (_i: unknown, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    await new GithubIssueTracker({ fetch: impl, token: tokenOk }).listOpen("o/r", "x");
    expect(seen[0].authorization).toBe("Bearer tok-123");
    expect(seen[0]["user-agent"]).toBe("switchboard");
  });

  it("clips an oversized body so the issue still opens", async () => {
    const { fetch, calls } = fakeFetch(({ url, method }) => {
      if (url.includes("/labels/")) return { status: 200, body: {} };
      if (url.endsWith("/issues") && method === "POST")
        return { status: 201, body: { number: 1, title: "T", body: "B", html_url: "u" } };
      return undefined;
    });
    await new GithubIssueTracker({ fetch, token: tokenOk }).create("o/r", {
      title: "T",
      body: "x".repeat(70_000),
      labels: ["l"],
    });
    const sent = calls.find((c) => c.url.endsWith("/issues"))!.body as { body: string };
    expect(sent.body.length).toBeLessThan(66_000);
    expect(sent.body).toMatch(/truncated/);
  });
});

describe("InMemoryIssueTracker", () => {
  it("creates numbered issues, lists only OPEN ones with the label, and records its calls", async () => {
    const t = new InMemoryIssueTracker();
    const a = await t.create("o/r", { title: "A", body: "a", labels: ["x"] });
    const b = await t.create("o/r", { title: "B", body: "b", labels: ["y"] });
    expect(a.number).toBe(1);
    expect(b.number).toBe(2);
    expect(a.url).toBe("https://github.com/o/r/issues/1");
    expect((await t.listOpen("o/r", "x")).map((i) => i.number)).toEqual([1]);
    t.close("o/r", 1);
    expect(await t.listOpen("o/r", "x")).toEqual([]);
    expect(await t.listOpen("other/repo", "y")).toEqual([]);
    expect(t.calls).toEqual(["create o/r", "create o/r", "listOpen o/r x", "listOpen o/r x", "listOpen other/repo y"]);
  });
});
