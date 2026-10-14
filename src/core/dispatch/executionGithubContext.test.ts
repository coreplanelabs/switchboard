import { describe, expect, it } from "vitest";
import {
  GithubApiError,
  GithubCredentialUnavailable,
  GithubResponseDecodeError,
  InMemoryGithubApi,
  RestGithubApi,
} from "../../execution/githubApi.js";
import { classifyError } from "../trace/classify.js";
import { currentGithubReadCapability } from "./executionGithubContext.js";

describe("current native execution read authority", () => {
  it.each(["installation_repos", "contents", "pull_reviews"] as const)(
    "retains observed response facts for %s JSON decode failure",
    async (route) => {
      const api = new RestGithubApi({
        token: async () => "private token",
        fetch: async (url) => {
          const path = String(url);
          if (path.includes("/installation/repositories") && route !== "installation_repos")
            return Response.json({ repositories: [{ full_name: "acme/private", private: true }] });
          if (path.endsWith("/pulls/7"))
            return Response.json({
              number: 7,
              state: "closed",
              head: { repo: { full_name: "acme/private" }, ref: "main", sha: "a".repeat(40) },
              base: { repo: { full_name: "acme/private" }, ref: "main" },
            });
          return new Response("private malformed JSON", { status: 200, headers: { "x-github-request-id": "A1:B2" } });
        },
      });
      const tool = route === "pull_reviews" ? "github_pull_get" : "github_file";
      const result = await currentGithubReadCapability(
        {
          version: 2,
          runId: "run",
          callId: "call",
          tool,
          repos: ["acme/private"],
          resultHash: "a".repeat(64),
          inputHash: "b".repeat(64),
          admissionHash: "c".repeat(64),
        },
        route === "pull_reviews"
          ? { repo: "acme/private", number: 7, includeReviewHistory: true, historyPage: 1 }
          : { repo: "acme/private", path: "private.ts" },
        { api, canWrite: () => false },
        "review",
      );
      expect(result).toEqual({
        ok: false,
        githubAccess: {
          tool,
          stage: route === "installation_repos" ? "catalog" : "tool-read",
          operation:
            route === "installation_repos" ? "listRepos" : route === "contents" ? "readFile" : "getPullRequestFeedback",
          route,
          reason: "decode",
          httpStatus: 200,
          requestId: "A1:B2",
          sourceCallHash: "9fd6fd2ffd299ff3691b5e216c4778afe73ff2b7e23fb14e138b032cfc0994e0",
        },
      });
      expect(JSON.stringify(result)).not.toMatch(/private|malformed|token/);
    },
  );
  it.each(["http", "transport"] as const)(
    "identifies signed job-log %s failures without exposing signed URLs",
    async (failure) => {
      const api = new RestGithubApi({
        token: async () => "private token",
        fetch: async (url) => {
          const path = String(url);
          if (path.includes("/installation/repositories"))
            return Response.json({ repositories: [{ full_name: "acme/private", private: true }] });
          if (path.endsWith("/actions/jobs/7"))
            return Response.json({ id: 7, status: "completed", conclusion: "success" });
          if (path.endsWith("/actions/jobs/7/logs"))
            return new Response(null, {
              status: 302,
              headers: { location: "https://logs.example.test/blob?signature=private" },
            });
          if (failure === "transport") throw new TypeError("private signed URL");
          return new Response("private blob body", { status: 403 });
        },
      });
      const result = await currentGithubReadCapability(
        {
          version: 2,
          runId: "run",
          callId: "call",
          tool: "github_actions_job_log",
          repos: ["acme/private"],
          resultHash: "a".repeat(64),
          inputHash: "b".repeat(64),
          admissionHash: "c".repeat(64),
        },
        { repo: "acme/private", job: "7" },
        { api, canWrite: () => false },
        "review",
      );
      expect(result).toEqual({
        ok: false,
        githubAccess: {
          tool: "github_actions_job_log",
          stage: "tool-read",
          operation: "getActionsJobLog",
          route: "actions_job_logs_blob",
          reason: failure,
          sourceCallHash: "9fd6fd2ffd299ff3691b5e216c4778afe73ff2b7e23fb14e138b032cfc0994e0",
          ...(failure === "http" ? { httpStatus: 403 } : {}),
        },
      });
      expect(JSON.stringify(result)).not.toMatch(/private|signature|https|body/);
    },
  );
  it("attributes a concurrent Actions failure to its original read operation", async () => {
    const api = new InMemoryGithubApi({ "acme/private": {} });
    api.getActionsJob = async () => {
      await Promise.resolve();
      throw new GithubApiError(403, "private body", "A1:B2", "actions_job");
    };
    api.getActionsJobLog = async () => ({ text: "log", complete: true });
    const result = await currentGithubReadCapability(
      {
        version: 2,
        runId: "run",
        callId: "call",
        tool: "github_actions_job_log",
        repos: ["acme/private"],
        resultHash: "a".repeat(64),
        inputHash: "b".repeat(64),
        admissionHash: "c".repeat(64),
      },
      { repo: "acme/private", job: "7" },
      { api, canWrite: () => false },
      "review",
    );
    expect(result).toEqual({
      ok: false,
      githubAccess: {
        tool: "github_actions_job_log",
        stage: "tool-read",
        operation: "getActionsJob",
        route: "actions_job",
        reason: "http",
        httpStatus: 403,
        requestId: "A1:B2",
        sourceCallHash: "9fd6fd2ffd299ff3691b5e216c4778afe73ff2b7e23fb14e138b032cfc0994e0",
      },
    });
  });
  it.each(["http", "transport"] as const)("identifies a native %s failure without a parent trace", async (failure) => {
    const api = new RestGithubApi({
      token: async () => "private token",
      fetch: async (url) => {
        const path = String(url);
        if (path.includes("/installation/repositories"))
          return Response.json({ repositories: [{ full_name: "acme/private", private: true }] });
        if (path.endsWith("/pulls/7"))
          return Response.json({
            number: 7,
            state: "closed",
            head: { repo: { full_name: "acme/private" }, ref: "main", sha: "a".repeat(40) },
            base: { repo: { full_name: "acme/private" }, ref: "main" },
          });
        if (failure === "transport") throw new TypeError("private transport path and token");
        return new Response("private refusal body", { status: 403, headers: { "x-github-request-id": "A1:B2" } });
      },
    });
    const result = await currentGithubReadCapability(
      {
        version: 2,
        runId: "run",
        callId: "call",
        tool: "github_pull_get",
        repos: ["acme/private"],
        resultHash: "a".repeat(64),
        inputHash: "b".repeat(64),
        admissionHash: "c".repeat(64),
      },
      { repo: "acme/private", number: 7, includeReviewHistory: true, historyPage: 1 },
      { api, canWrite: () => false },
      "review",
    );
    expect(result).toEqual({
      ok: false,
      githubAccess: {
        tool: "github_pull_get",
        stage: "tool-read",
        operation: "getPullRequestFeedback",
        route: "pull_reviews",
        reason: failure,
        sourceCallHash: "9fd6fd2ffd299ff3691b5e216c4778afe73ff2b7e23fb14e138b032cfc0994e0",
        ...(failure === "http" ? { httpStatus: 403, requestId: "A1:B2" } : {}),
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|token|body|path/);
  });
  it.each(["removed installation", "revoked contents"])(
    "denies old private code after %s despite an empty successful global search",
    async (gap) => {
      const api = new InMemoryGithubApi(gap === "removed installation" ? {} : { "acme/private": { private: true } });
      api.searchCode = async () => [];
      if (gap === "revoked contents")
        api.listTree = async () => {
          throw new Error("contents permission revoked");
        };
      expect(
        await currentGithubReadCapability(
          {
            version: 2,
            runId: "run",
            callId: "call",
            tool: "github_search_code",
            repos: ["acme/private"],
            resultHash: "a".repeat(64),
            inputHash: "b".repeat(64),
            admissionHash: "c".repeat(64),
          },
          { query: "old private code" },
          { api, canWrite: () => false },
          "review",
        ),
      ).toMatchObject({
        ok: false,
        githubAccess: {
          stage: gap === "removed installation" ? "repository" : "contents",
          reason: gap === "removed installation" ? "repository-missing" : "unknown",
        },
      });
    },
  );

  it("denies an unrecognized global issue search family rather than treating a catalog as authority", async () => {
    const api = new InMemoryGithubApi({ "acme/private": { private: true } });
    expect(
      await currentGithubReadCapability(
        {
          version: 2,
          runId: "run",
          callId: "call",
          tool: "github_search_issues",
          repos: ["acme/private"],
          resultHash: "a".repeat(64),
          inputHash: "b".repeat(64),
          admissionHash: "c".repeat(64),
        },
        { query: "old private issue" },
        { api, canWrite: () => false },
        "review",
      ),
    ).toMatchObject({ ok: false, githubAccess: { stage: "tool-family", reason: "unsupported-tool", tool: "unknown" } });
  });

  it.each([
    ["catalog", "listRepos", new GithubCredentialUnavailable(), "credential-missing", {}],
    ["catalog", "listRepos", new GithubCredentialUnavailable("failed"), "credential-failed", {}],
    [
      "tool-read",
      "readFile",
      new GithubApiError(403, "secret body token", "A1:B2", "contents"),
      "http",
      { httpStatus: 403, requestId: "A1:B2", route: "contents" },
    ],
    [
      "tool-read",
      "readFile",
      new GithubApiError(404, "private path", "invalid private id", "contents"),
      "http",
      { httpStatus: 404, route: "contents" },
    ],
    ["tool-read", "readFile", new GithubApiError(502, "local validation error"), "api", {}],
    ["tool-read", "readFile", new DOMException("secret timeout", "TimeoutError"), "timeout", {}],
    ["tool-read", "readFile", classifyError(new Error("secret transport"), { kind: "transport" }), "transport", {}],
    [
      "tool-read",
      "readFile",
      new GithubResponseDecodeError(200, "A1:B2"),
      "decode",
      { httpStatus: 200, requestId: "A1:B2", route: "pull" },
    ],
    ["tool-read", "readFile", new Error("secret response"), "unknown", {}],
  ] as const)("retains %s %s failure facts without source bytes", async (stage, operation, error, reason, facts) => {
    const api = new InMemoryGithubApi({ "acme/private": { files: { "private.ts": "secret code" } } });
    api[operation] = async () => {
      throw error;
    };
    const result = await currentGithubReadCapability(
      {
        version: 2,
        runId: "run",
        callId: "call",
        tool: "github_file",
        repos: ["acme/private"],
        resultHash: "a".repeat(64),
        inputHash: "b".repeat(64),
        admissionHash: "c".repeat(64),
      },
      { repo: "acme/private", path: "private.ts" },
      { api, canWrite: () => false },
      "review",
    );
    expect(result).toEqual({
      ok: false,
      githubAccess: {
        tool: "github_file",
        stage,
        operation,
        reason,
        sourceCallHash: "9fd6fd2ffd299ff3691b5e216c4778afe73ff2b7e23fb14e138b032cfc0994e0",
        ...facts,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private\.ts|acme\/private|invalid private id/);
  });

  it("allows current reads and distinguishes a tool that never reaches the API", async () => {
    const api = new InMemoryGithubApi({ "acme/private": { files: { "x.ts": "code" } } });
    const receipt = {
      version: 2 as const,
      runId: "run",
      callId: "call",
      tool: "github_file",
      repos: ["acme/private"],
      resultHash: "a".repeat(64),
      inputHash: "b".repeat(64),
      admissionHash: "c".repeat(64),
    };
    expect(
      await currentGithubReadCapability(
        receipt,
        { repo: "acme/private", path: "x.ts" },
        { api, canWrite: () => false },
        "review",
      ),
    ).toEqual({ ok: true });
    expect(
      await currentGithubReadCapability(receipt, { repo: "acme/private" }, { api, canWrite: () => false }, "review"),
    ).toMatchObject({ ok: false, githubAccess: { stage: "tool-read", reason: "no-api-call", operation: "none" } });
  });
});
