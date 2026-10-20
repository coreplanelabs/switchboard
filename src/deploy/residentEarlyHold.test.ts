import { describe, expect, it } from "vitest";
import { residentEarlyHoldProblem } from "./residentEarlyHold.js";

const resource = "repo:acme/widgets";
const row = { resource, live: { inFlight: 0 } };
const hash = "a".repeat(64);

const operationProblem = (operation: Record<string, unknown>) =>
  residentEarlyHoldProblem({
    baseUrl: "https://resident.example.test",
    bearer: "read-only",
    readHealth: async () => ({ status: 200, body: { draining: null, count: 1, inFlightUnknown: 0, residents: [row] } }),
    postJson: async () => ({ status: 200, body: { operations: [operation], cursor: null } }),
  });

const owner = { runId: "run-a", ownerGen: "generation-a", ownerFence: 1 };
const scope = {
  version: 1 as const,
  id: "11111111-1111-4111-8111-111111111111",
  boot: "22222222-2222-4222-8222-222222222222",
  threadKey: "thread-a",
  owner,
};
const original = {
  key: "native-operation:thread-a:run-a:attempt-a",
  recordHash: hash,
  recoverable: false,
  recoveryReason: "original-native-evidence-unavailable",
  journal: { closed: false, scope },
};
const retirementRecords = { [original.key]: hash };
const retirements = [
  {
    name: "scope",
    receipt: {
      scope,
      cancellationId: "original-cancellation",
      controllerOwnerGen: "controller-a",
      records: retirementRecords,
      originalOperationOutcome: "unknown",
    },
  },
  {
    name: "runtime",
    receipt: {
      version: 1,
      cancellationId: "original-cancellation",
      owner,
      threadKey: "thread-a",
      originalBoot: scope.boot,
      currentBoot: "33333333-3333-4333-8333-333333333333",
      records: retirementRecords,
      originalOperationOutcome: "unknown",
    },
  },
  {
    name: "terminal",
    receipt: {
      purpose: "terminal-native-scope",
      state: "closed",
      records: retirementRecords,
      originalOperationOutcome: "unknown",
      permit: {
        version: 1,
        purpose: "terminal-native-scope",
        id: "44444444-4444-4444-8444-444444444444",
        target: { resource, key: original.key, recordHash: hash, scope },
        source: {
          id: owner.runId,
          threadKey: "thread-a",
          repo: "acme/widgets",
          status: "completed",
          startedAt: 1,
          finishedAt: 2,
          sealedAt: 3,
        },
      },
    },
  },
];

describe("read-only Resident hold check", () => {
  it("accepts every unchanged record covered by a terminal scope retirement", async () => {
    const sibling = { ...original, key: "native-operation:thread-a:run-a:attempt-b", recordHash: "b".repeat(64) };
    const receipt = {
      ...retirements[2]!.receipt,
      records: { [original.key]: hash, [sibling.key]: sibling.recordHash },
    };
    const check = (retirement = receipt, journal = sibling.journal) =>
      residentEarlyHoldProblem({
        baseUrl: "https://resident.example.test",
        bearer: "read-only",
        readHealth: async () => ({
          status: 200,
          body: { draining: null, count: 1, inFlightUnknown: 0, residents: [row] },
        }),
        postJson: async () => ({
          status: 200,
          body: {
            operations: [original, sibling].map((operation) => ({
              ...operation,
              journal,
              recoveryReason: "original-runtime-retired",
              retirement,
            })),
            cursor: null,
          },
        }),
      });
    expect(await check()).toBeNull();
    expect(await check({ ...receipt, records: { ...receipt.records, [sibling.key]: "c".repeat(64) } })).toBe(
      `resident deployment inventory unavailable before any Worker upload: native operation row incomplete for ${resource}`,
    );
    expect(
      await check(receipt, { ...sibling.journal, scope: { ...scope, boot: "55555555-5555-4555-8555-555555555555" } }),
    ).toBe(
      `resident deployment inventory unavailable before any Worker upload: native operation row incomplete for ${resource}`,
    );
  });

  it.each(["before-list", "after-list", "page", "resident"])(
    "stops inventory reads on cancellation at %s",
    async (boundary) => {
      const control = new AbortController();
      const calls: string[] = [];
      const firstPage = Array.from({ length: 25 }, (_, index) => ({
        ...original,
        key: `native-operation:thread-a:run-a:${String(index).padStart(2, "0")}`,
      }));
      if (boundary === "before-list") control.abort();
      const result = await residentEarlyHoldProblem({
        baseUrl: "https://resident.example.test",
        bearer: "read-only",
        signal: control.signal,
        readHealth: async () => {
          calls.push("fleet");
          if (boundary === "after-list") control.abort();
          return {
            status: 200,
            body: {
              draining: null,
              count: 2,
              inFlightUnknown: 0,
              residents: [row, { resource: "repo:acme/other", live: { inFlight: 0 } }],
            },
          };
        },
        postJson: async (_url, _bearer, body) => {
          calls.push(String(body.resource));
          control.abort();
          return boundary === "page" && !body.cursor
            ? { status: 200, body: { operations: firstPage, cursor: firstPage.at(-1)!.key } }
            : { status: 200, body: { operations: [], cursor: null } };
        },
      });
      expect(result).toBe("deployment cancelled");
      expect(calls).toEqual(
        boundary === "before-list" ? [] : boundary === "after-list" ? ["fleet"] : ["fleet", resource],
      );
    },
  );

  it.each(retirements)("accepts only the matching record hash in $name retirement evidence", async ({ receipt }) => {
    const operation = { ...original, recoveryReason: "original-runtime-retired", retirement: receipt };
    expect(await operationProblem(operation)).toBeNull();
    expect(
      await operationProblem({ ...operation, retirement: { ...receipt, records: { [original.key]: "b".repeat(64) } } }),
    ).toBe(
      `resident deployment inventory unavailable before any Worker upload: native operation row incomplete for ${resource}`,
    );
  });

  it.each([
    {
      name: "changed scope owner",
      receipt: { ...retirements[0]!.receipt, scope: { ...scope, owner: { ...owner, runId: "foreign-run" } } },
    },
    { name: "missing cancellation", receipt: { ...retirements[0]!.receipt, cancellationId: null } },
    { name: "unchanged runtime boot", receipt: { ...retirements[1]!.receipt, currentBoot: scope.boot } },
    { name: "prepared terminal scope", receipt: { ...retirements[2]!.receipt, state: "prepared" } },
  ])("refuses incomplete retirement: $name", async ({ receipt }) => {
    expect(
      await operationProblem({ ...original, recoveryReason: "original-runtime-retired", retirement: receipt }),
    ).toBe(
      `resident deployment inventory unavailable before any Worker upload: native operation row incomplete for ${resource}`,
    );
  });

  it.each([
    ...[
      "legacy-or-invalid-record",
      "original-native-evidence-unavailable",
      "original-process-result-required",
      "original-runtime-retired",
    ].map((reason) => ({
      name: `array reason ${reason}`,
      operation: { ...original, recoveryReason: [reason] },
    })),
    ...[null, {}].map((retirement) => ({
      name: `retirement ${JSON.stringify(retirement)}`,
      operation: {
        ...original,
        recoveryReason: "original-runtime-retired",
        retirement,
      },
    })),
  ])("refuses malformed operation evidence: $name", async ({ operation }) => {
    expect(await operationProblem(operation)).toBe(
      `resident deployment inventory unavailable before any Worker upload: native operation row incomplete for ${resource}`,
    );
  });

  it("reads every native-operation page before allowing the first Worker upload", async () => {
    const first = Array.from({ length: 25 }, (_, index) => ({
      key: `native-operation:op:${String(index).padStart(2, "0")}`,
      recordHash: hash,
      recoverable: true,
      recoveryReason: "original-process-result-required",
      journal: { closed: false },
    }));
    const cursors: unknown[] = [];
    expect(
      await residentEarlyHoldProblem({
        baseUrl: "https://resident.example.test",
        bearer: "read-only",
        readHealth: async () => ({
          status: 200,
          body: { draining: null, count: 1, inFlightUnknown: 0, residents: [row] },
        }),
        postJson: async (_url, _bearer, body) => {
          cursors.push(body.cursor ?? null);
          return body.cursor
            ? {
                status: 200,
                body: {
                  operations: [
                    {
                      key: "native-operation:op:zz",
                      recordHash: hash,
                      recoverable: false,
                      recoveryReason: "original-native-evidence-unavailable",
                      journal: { closed: true },
                    },
                  ],
                  cursor: null,
                },
              }
            : { status: 200, body: { operations: first, cursor: first.at(-1)!.key } };
        },
      }),
    ).toBe(
      `resident deployment blocked before any Worker upload: ${resource} has closed "native-operation:op:zz" at ${hash} without original ending evidence; resolve that exact record before deployment`,
    );
    expect(cursors).toEqual([null, "native-operation:op:24"]);
  });

  it("leaves an open original operation to the final fenced preflight", async () => {
    expect(
      await residentEarlyHoldProblem({
        baseUrl: "https://resident.example.test",
        bearer: "read-only",
        readHealth: async () => ({
          status: 200,
          body: { draining: null, count: 1, inFlightUnknown: 0, residents: [row] },
        }),
        postJson: async () => ({
          status: 200,
          body: {
            operations: [
              {
                key: "native-operation:op:original-restore",
                recordHash: hash,
                recoverable: false,
                recoveryReason: "original-native-evidence-unavailable",
                journal: { closed: false },
              },
            ],
            cursor: null,
          },
        }),
      }),
    ).toBeNull();
  });

  it("refuses an incomplete fleet view before reading an operation", async () => {
    expect(
      await residentEarlyHoldProblem({
        baseUrl: "https://resident.example.test",
        bearer: "read-only",
        readHealth: async () => ({
          status: 200,
          body: { draining: null, count: 1, inFlightUnknown: 1, residents: [row] },
        }),
      }),
    ).toBe("resident deployment inventory unavailable before any Worker upload: resident list incomplete");
  });

  it("refuses an invalid retained record before the first upload", async () => {
    expect(
      await residentEarlyHoldProblem({
        baseUrl: "https://resident.example.test",
        bearer: "read-only",
        readHealth: async () => ({
          status: 200,
          body: { draining: null, count: 1, inFlightUnknown: 0, residents: [row] },
        }),
        postJson: async () => ({
          status: 200,
          body: {
            operations: [
              {
                key: "native-operation:op:legacy",
                recordHash: hash,
                recoverable: false,
                recoveryReason: "legacy-or-invalid-record",
                journal: null,
              },
            ],
            cursor: null,
          },
        }),
      }),
    ).toBe(
      `resident deployment blocked before any Worker upload: ${resource} has unreadable "native-operation:op:legacy" at ${hash}; reconcile this record before deployment`,
    );
  });

  it("refuses a native page that claims more rows without returning a full page", async () => {
    expect(
      await residentEarlyHoldProblem({
        baseUrl: "https://resident.example.test",
        bearer: "read-only",
        readHealth: async () => ({
          status: 200,
          body: { draining: null, count: 1, inFlightUnknown: 0, residents: [row] },
        }),
        postJson: async () => ({
          status: 200,
          body: {
            operations: [
              {
                key: "native-operation:op:only",
                recordHash: hash,
                recoverable: true,
                recoveryReason: "original-process-result-required",
              },
            ],
            cursor: "native-operation:op:only",
          },
        }),
      }),
    ).toBe(
      `resident deployment inventory unavailable before any Worker upload: native operation page incomplete for ${resource}`,
    );
  });
});
