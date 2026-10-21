import { afterEach, describe, expect, it, vi } from "vitest";
import { retryTransientSourceCheck, sourceCheckError } from "./sourceCheckError.js";
import { classificationOf, classifyError } from "../trace/classify.js";
import { rememberStorageFailure } from "../storageFailureDiagnostic.js";
import { noteStoreReadFailure, TransientStoreError } from "../storeFailure.js";
import { RestGithubApi } from "../../execution/githubApi.js";
import { invalidAttrKeys } from "../trace/attrs.js";

afterEach(() => vi.restoreAllMocks());

describe("source check failure reporting", () => {
  it.each([
    [
      "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      "secondary-rate-limit-indicated",
    ],
    ["Resource not accessible by integration", "permission-indicated"],
    ["API rate limit exceeded for user ID PRIVATE_USER", "primary-rate-limit-indicated"],
  ] as const)("keeps a closed GitHub reason for %s", async (message, reason) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = new RestGithubApi({
      token: async () => "read-token",
      fetch: (async () => new Response(JSON.stringify({ message }), { status: 403 })) as typeof fetch,
    });
    const cause = await api.listRepos().catch((error: unknown) => error);
    const failure = sourceCheckError("github-repositories", cause);

    expect(failure.refusal).toEqual({
      ok: false,
      code: "saved-context-unproved",
      check: "context_validation_exception",
    });
    expect(failure.diagnostic).toMatchObject({
      sourceCheckStage: "github-repositories",
      httpStatus: 403,
      githubResponseReason: reason,
    });
    expect(invalidAttrKeys(failure.diagnostic)).toEqual([]);
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toMatchObject([
      { event: "source_check.failed", httpStatus: 403, githubResponseReason: reason },
    ]);
    expect(JSON.stringify([failure.diagnostic, log.mock.calls])).not.toContain("PRIVATE_USER");
    if (reason === "primary-rate-limit-indicated")
      expect(failure.diagnostic.githubResponseMessage).toBe("API rate limit exceeded for user ID «redacted»");
  });

  it("keeps one redacted, capped GitHub message without a URL or later lines", async () => {
    const message =
      "Denied for https://github.com/private/repo?token=secret with ghp_123456789012345678901234567890 and user@example.com\nPRIVATE_SECOND_LINE";
    const api = new RestGithubApi({
      token: async () => "read-token",
      fetch: (async () => new Response(JSON.stringify({ message }), { status: 403 })) as typeof fetch,
    });
    const cause = await api.listRepos().catch((error: unknown) => error);
    const failure = sourceCheckError("github-repositories", cause);

    expect(failure.diagnostic).toMatchObject({
      httpStatus: 403,
      githubResponseMessage: "Denied for «redacted-url» with «redacted-github-token» and «redacted-email»",
    });
    expect(invalidAttrKeys(failure.diagnostic)).toEqual([]);
    expect(JSON.stringify(failure.diagnostic)).not.toMatch(
      /private\/repo|PRIVATE_SECOND_LINE|user@example.com|ghp_1234/,
    );
  });

  it("caps the retained GitHub message before it enters a run span", async () => {
    const api = new RestGithubApi({
      token: async () => "read-token",
      fetch: (async () => new Response(JSON.stringify({ message: "A".repeat(300) }), { status: 403 })) as typeof fetch,
    });
    const cause = await api.listRepos().catch((error: unknown) => error);
    const failure = sourceCheckError("github-repositories", cause);
    expect(failure.diagnostic.githubResponseMessage).toBe(`${"A".repeat(240)}…`);
    expect(invalidAttrKeys(failure.diagnostic)).toEqual([]);
  });

  it("retains bounded GitHub response facts on a permanent source refusal", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let requests = 0;
    const api = new RestGithubApi({
      token: async () => "read-token",
      fetch: (async () => {
        requests++;
        return new Response("PRIVATE_GITHUB_RESPONSE", {
          status: 403,
          headers: {
            "x-github-request-id": "A1:B2",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1792620000",
            "x-ratelimit-resource": "core",
            "retry-after": "120",
          },
        });
      }) as typeof fetch,
    });
    const cause = await retryTransientSourceCheck(
      async () => {
        await api.listRepos();
        return { ok: true };
      },
      () => true,
    ).catch((error: unknown) => error);
    const failure = sourceCheckError("github-repositories", cause);

    expect(requests).toBe(1);
    expect(failure.cause).toBe(cause);
    expect(failure.refusal).toEqual({
      ok: false,
      code: "saved-context-unproved",
      check: "context_validation_exception",
    });
    expect(failure.diagnostic).toMatchObject({
      sourceCheckStage: "github-repositories",
      httpStatus: 403,
      githubRequestId: "A1:B2",
      githubRateLimitRemaining: 0,
      githubRateLimitResetEpochSeconds: 1792620000,
      githubRateLimitResource: "core",
      githubRetryAfterSeconds: 120,
    });
    expect(invalidAttrKeys(failure.diagnostic)).toEqual([]);
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toMatchObject([
      {
        event: "source_check.failed",
        sourceCheckStage: "github-repositories",
        httpStatus: 403,
        githubRequestId: "A1:B2",
        githubRateLimitRemaining: 0,
        githubRateLimitResetEpochSeconds: 1792620000,
        githubRateLimitResource: "core",
        githubRetryAfterSeconds: 120,
      },
    ]);
    expect(JSON.stringify([failure.diagnostic, log.mock.calls])).not.toContain("PRIVATE_GITHUB_RESPONSE");
  });

  it("omits untrusted GitHub header text while retaining the HTTP refusal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const api = new RestGithubApi({
      token: async () => "read-token",
      fetch: (async () =>
        new Response("PRIVATE_GITHUB_RESPONSE", {
          status: 403,
          headers: {
            "x-github-request-id": "PRIVATE/path?token=secret",
            "x-ratelimit-remaining": "-1",
            "x-ratelimit-reset": "9999999999",
            "x-ratelimit-resource": "PRIVATE/path?token=secret",
            "retry-after": "Wed, 21 Oct 2026 23:00:00 GMT",
          },
        })) as typeof fetch,
    });
    const cause = await api.listRepos().catch((error: unknown) => error);
    const failure = sourceCheckError("github-repositories", cause);

    expect(failure.diagnostic).toMatchObject({ sourceCheckStage: "github-repositories", httpStatus: 403 });
    expect(failure.diagnostic).not.toHaveProperty("githubRequestId");
    expect(failure.diagnostic).not.toHaveProperty("githubRateLimitRemaining");
    expect(failure.diagnostic).not.toHaveProperty("githubRateLimitResetEpochSeconds");
    expect(failure.diagnostic).not.toHaveProperty("githubRateLimitResource");
    expect(failure.diagnostic).not.toHaveProperty("githubRetryAfterSeconds");
    expect(failure.diagnostic).not.toHaveProperty("githubResponseReason");
    expect(JSON.stringify(failure.diagnostic)).not.toContain("PRIVATE");
  });

  it("records a recovered raw source read without copying private bytes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let checks = 0;
    const checked = await retryTransientSourceCheck(
      async () => {
        if (++checks === 1) throw new TransientStoreError("PRIVATE_SOURCE_BYTES");
        return { ok: true } as const;
      },
      () => true,
    );
    expect(checked).toEqual({ ok: true });
    expect(checks).toBe(2);
    expect(warn.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { event: "source_check.retry", trigger: "storage", outcome: "allowed" },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE_SOURCE_BYTES");
  });

  it("keeps a recovered source check valid when both retry reporters fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("warning reporter unavailable");
    });
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("error reporter unavailable");
    });
    let checks = 0;
    const checked = await retryTransientSourceCheck(
      async () => {
        if (++checks === 1) throw new TransientStoreError("PRIVATE_SOURCE_BYTES");
        return { ok: true } as const;
      },
      () => true,
    );
    expect(checked).toEqual({ ok: true });
    expect(checks).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("records a fresh refusal after a classified timeout", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const timeout = sourceCheckError(
      "github-repositories",
      classifyError(new Error("PRIVATE_SOURCE_BYTES"), { kind: "timeout", code: "installation_repositories" }),
    );
    let checks = 0;
    const checked = await retryTransientSourceCheck(
      async () => {
        if (++checks === 1) throw timeout;
        return { ok: false, code: "saved-context-unproved", check: "github_repository_unproved" } as const;
      },
      () => true,
    );
    expect(checked).toEqual({ ok: false, code: "saved-context-unproved", check: "github_repository_unproved" });
    expect(checks).toBe(2);
    expect(warn.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { event: "source_check.retry", trigger: "timeout", outcome: "refused", sourceCheckStage: "github-repositories" },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE_SOURCE_BYTES");
  });

  it("keeps the second failure and records a failed retry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = new Error("PRIVATE_SECOND_FAILURE");
    let checks = 0;
    await expect(
      retryTransientSourceCheck(
        async () => {
          if (++checks === 1) throw new TransientStoreError("PRIVATE_FIRST_FAILURE");
          throw second;
        },
        () => true,
      ),
    ).rejects.toBe(second);
    expect(checks).toBe(2);
    expect(warn.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { event: "source_check.retry", trigger: "storage", outcome: "failed" },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE_");
  });

  it("keeps the original cause and reports closed storage evidence once across translations", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = new TransientStoreError("PRIVATE_RESPONSE_BYTES");
    rememberStorageFailure(cause, {
      version: 1,
      operation: "/runs/session/read",
      phase: "http",
      kind: "read",
      requestDigest: "a".repeat(64),
      requestId: "00000000-0000-4000-8000-000000000001",
      httpStatus: 503,
    });
    noteStoreReadFailure(cause, 3, "attempts-exhausted");
    const error = sourceCheckError("github-execution", cause);
    expect(error.cause).toBe(cause);
    expect(error.refusal).toEqual({ ok: false, code: "saved-context-unproved", check: "context_validation_exception" });
    expect(sourceCheckError("admitted-context", error)).toBe(error);
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      {
        event: "source_check.failed",
        sourceCheckStage: "github-execution",
        sourceErrorClass: "TransientStoreError",
        storageOperation: "/runs/session/read",
        storagePhase: "http",
        requestDigest: "a".repeat(64),
        storageRequestId: "00000000-0000-4000-8000-000000000001",
        httpStatus: 503,
        sourceReadAttempts: 3,
        sourceReadStop: "attempts-exhausted",
        kind: "infra",
        code: "source_check_failed",
      },
    ]);
  });

  it("preserves an existing classification without copying arbitrary error properties", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = classifyError(
      Object.assign(new TypeError("PRIVATE_SOURCE_BYTES"), {
        name: "PRIVATE_ERROR_NAME",
        code: "PRIVATE_CODE",
        stack: "PRIVATE_STACK",
      }),
      { kind: "timeout", code: "source_read_deadline" },
    );
    const error = sourceCheckError("origins", cause);
    expect(error.cause).toBe(cause);
    expect(classificationOf(error)).toEqual({ kind: "timeout", code: "source_read_deadline" });
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      {
        event: "source_check.failed",
        sourceCheckStage: "origins",
        sourceErrorClass: "TypeError",
        kind: "timeout",
        code: "source_read_deadline",
      },
    ]);
    expect(JSON.stringify([error.diagnostic, log.mock.calls])).not.toContain("PRIVATE_");
  });

  it("keeps audience and Slack refusal categories separate from unexpected context failures", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(sourceCheckError("private-audience", new Error()).refusal).toEqual({
      ok: false,
      code: "direct-audience-unavailable",
    });
    expect(sourceCheckError("slack-revalidation", new Error()).refusal).toEqual({
      ok: false,
      code: "slack-source-unverified",
    });
  });

  it("records an application location without retaining the stack or exception header", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = new TypeError("PRIVATE_RESPONSE_BYTES");
    cause.stack =
      "TypeError: PRIVATE_RESPONSE_BYTES\n    at decode (/app/src/core/runLedgerWorker.ts:425:17)\n    at external (/private/customer/repo.js:1:2)";
    const error = sourceCheckError("github-execution", cause);
    expect(error.cause).toBe(cause);
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      {
        event: "source_check.failed",
        sourceCheckStage: "github-execution",
        sourceErrorClass: "TypeError",
        sourceErrorFile: "core/runLedgerWorker.ts",
        sourceErrorLine: 425,
        sourceErrorColumn: 17,
        kind: "infra",
        code: "source_check_failed",
      },
    ]);
  });

  it.each(["/app/src/core/private-name.ts:1:2", "    at privateName (/app/src/core/private-name.ts:1:2)"])(
    "excludes the full multiline error header containing %s",
    (fragment) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const cause = new TypeError(`PRIVATE_RESPONSE_BYTES\n${fragment}`);
      cause.stack = `TypeError: ${cause.message}\n    at decode (/app/src/core/runLedgerWorker.ts:425:17)`;
      const error = sourceCheckError("origins", cause);
      expect(error.diagnostic).toEqual({
        sourceCheckStage: "origins",
        sourceErrorClass: "TypeError",
        sourceErrorFile: "core/runLedgerWorker.ts",
        sourceErrorLine: 425,
        sourceErrorColumn: 17,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-name");
      expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_RESPONSE_BYTES");
    },
  );

  it("retains the source failure when both telemetry sinks fail", () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("log unavailable");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("fallback unavailable");
    });
    const cause = new SyntaxError("PRIVATE_JSON");
    const error = sourceCheckError("mcp-sources", cause);
    expect(error).toMatchObject({
      name: "SourceCheckError",
      message: "Source verification failed",
      cause,
      diagnostic: { sourceCheckStage: "mcp-sources", sourceErrorClass: "SyntaxError" },
    });
  });
});
