import { describe, expect, it, vi } from "vitest";
import { BASE_URL_ENV, decide, main, readToken } from "./preflight.mjs";

describe("selected staging maintenance preflight", () => {
  const attempt = {
    holdId: "11111111-1111-4111-8111-111111111111",
    generation: 1,
    id: "22222222-2222-4222-8222-222222222222",
    controllerId: "selected-controller",
    sourceCommit: "a".repeat(40),
    profileSha256: "3".repeat(64),
    configSha256: "4".repeat(64),
    deadline: 1_800_000_060_000,
  };
  const received = () => ({
    ...payload([]),
    payload: {
      ...payload([]).payload,
      stagingMaintenance: {
        schema: 1,
        holdId: attempt.holdId,
        generation: 1,
        state: "held",
        attempt: {
          id: attempt.id,
          controllerId: "selected-controller",
          sourceCommit: "a".repeat(40),
          profileSha256: "3".repeat(64),
          configSha256: "4".repeat(64),
          deadline: 1_800_000_060_000,
        },
        window: {
          state: "fenced",
          disposition: "operator-abandoned",
          requestEnd: "unobserved",
          nativeOutcome: "unverified",
          recordId: "33333333-3333-4333-8333-333333333333",
          originalRecordSha256: "5".repeat(64),
          decisionSha256: "6".repeat(64),
          observedAt: 1_800_000_000_000,
          stored: 1,
          excluded: 1,
          blocking: 0,
        },
      },
    },
  });

  // The installed legacy Worker returns no count, maintenance or producer diagnostic.
  const bootstrapFence = (workerVersion) => ({
    activeAdmissions: 1,
    fenceReady: false,
    draining: {
      since: "2026-01-01T00:00:00Z",
      until: "2026-01-01T00:30:00Z",
      swapFence: false,
      swapVersion: workerVersion,
    },
    residents: [
      {
        resource: "repo:acme/api",
        live: { state: "warm", inFlight: 0, runsInFlight: 0, executingRuns: 0, retainedRuns: 0, unknownRuns: 0 },
      },
    ],
  });

  it("refuses a changed bootstrap Worker version through the public preflight even under force", async () => {
    const expected = "00000000-0000-4000-8000-000000000001";
    const body = bootstrapFence("00000000-0000-4000-8000-000000000002");
    const wire = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(
        await main(["--force"], {
          RESIDENT_BASE_URL: "https://resident.example.test",
          RESIDENT_DRAIN_TOKEN: "fixture",
          RESIDENT_DEPLOY_ATTEMPT: JSON.stringify(attempt),
          RESIDENT_BOOTSTRAP_PREVIOUS_VERSION: expected,
          RESIDENT_BOOTSTRAP_UPLOAD_RESERVE_MS: "1200000",
          RESIDENT_BOOTSTRAP_RESOURCES: JSON.stringify(["repo:acme/api"]),
        }),
      ).toBe(1);
      expect(wire).toHaveBeenCalledTimes(1);
    } finally {
      wire.mockRestore();
      log.mockRestore();
      output.mockRestore();
    }
  });

  it("accepts the known-old fence Worker UUID without newer diagnostics", async () => {
    const expected = "00000000-0000-4000-8000-000000000001";
    const body = bootstrapFence(expected);
    const wire = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(
        await main(["--force"], {
          RESIDENT_BASE_URL: "https://resident.example.test",
          RESIDENT_DRAIN_TOKEN: "fixture",
          RESIDENT_DEPLOY_ATTEMPT: JSON.stringify(attempt),
          RESIDENT_BOOTSTRAP_PREVIOUS_VERSION: expected,
          RESIDENT_BOOTSTRAP_UPLOAD_RESERVE_MS: "1200000",
          RESIDENT_BOOTSTRAP_RESOURCES: JSON.stringify(["repo:acme/api"]),
        }),
      ).toBe(0);
      expect(wire).toHaveBeenCalledTimes(1);
    } finally {
      wire.mockRestore();
      log.mockRestore();
      output.mockRestore();
    }
  });

  it("admits only the separately selected exact released predecessor under successor bootstrap", async () => {
    const expected = "00000000-0000-4000-8000-000000000001";
    const previous = {
      holdId: attempt.holdId,
      generation: 1,
      attempt: Object.fromEntries(Object.entries(attempt).filter(([key]) => !["holdId", "generation"].includes(key))),
      fixtureSha256: "1".repeat(64),
      decisionSha256: "2".repeat(64),
      policySha256: "6".repeat(64),
      releasedAt: 1000,
      releaseDecisionSha256: "7".repeat(64),
      request: { id: "55555555-5555-4555-8555-555555555555", startedAt: 1000, recordSha256: "8".repeat(64) },
    };
    const next = {
      ...attempt,
      holdId: "33333333-3333-4333-8333-333333333333",
      generation: 2,
      id: "44444444-4444-4444-8444-444444444444",
      sourceCommit: "b".repeat(40),
    };
    const maintenance = {
      schema: 1,
      state: "released",
      holdId: previous.holdId,
      generation: 1,
      attempt: previous.attempt,
      fixtureSha256: previous.fixtureSha256,
      decisionSha256: previous.decisionSha256,
      releasedAt: 1000,
      releaseDecisionSha256: previous.releaseDecisionSha256,
      window: {
        state: "expired",
        recordId: previous.request.id,
        originalRecordSha256: previous.request.recordSha256,
        decisionSha256: previous.decisionSha256,
        disposition: "operator-abandoned",
        requestEnd: "unobserved",
        nativeOutcome: "unverified",
        stored: 1,
        excluded: 0,
        blocking: 1,
      },
    };
    let body = { ...bootstrapFence(expected), stagingMaintenance: maintenance };
    const wire = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(body));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = {
      RESIDENT_BASE_URL: "https://resident.example.test",
      RESIDENT_DRAIN_TOKEN: "fixture",
      RESIDENT_DEPLOY_ATTEMPT: JSON.stringify(next),
      RESIDENT_BOOTSTRAP_PREVIOUS_VERSION: expected,
      RESIDENT_BOOTSTRAP_RESOURCES: JSON.stringify(["repo:acme/api"]),
      RESIDENT_BOOTSTRAP_UPLOAD_RESERVE_MS: "1200000",
      RESIDENT_BOOTSTRAP_PREDECESSOR: JSON.stringify(previous),
    };
    try {
      expect(await main(["--force"], env)).toBe(0);
      const completeFence = body;
      body = { ...body, draining: undefined };
      expect(await main(["--force"], env)).toBe(1);
      body = completeFence;
      body = {
        ...body,
        residents: [
          {
            ...body.residents[0],
            live: {
              ...body.residents[0].live,
              inFlight: 1,
              runsInFlight: 1,
              executingRuns: 0,
              retainedRuns: 1,
              unknownRuns: 0,
            },
          },
        ],
      };
      expect(await main(["--force"], env)).toBe(0);
      for (const counts of [{ executingRuns: 1 }, { unknownRuns: 1 }, { retainedRuns: undefined }]) {
        const retainedBody = body;
        body = { ...body, residents: [{ ...body.residents[0], live: { ...body.residents[0].live, ...counts } }] };
        expect(await main(["--force"], env)).toBe(1);
        body = retainedBody;
      }
      body = { ...body, residents: bootstrapFence(expected).residents };
      expect(await main(["--force"], { ...env, RESIDENT_BOOTSTRAP_PREDECESSOR: undefined })).toBe(1);
      for (const changed of [
        { ...previous, releaseDecisionSha256: "0".repeat(64) },
        { ...previous, request: { ...previous.request, recordSha256: "0".repeat(64) } },
        { ...previous, attempt: { ...previous.attempt, sourceCommit: "c".repeat(40) } },
      ])
        expect(await main(["--force"], { ...env, RESIDENT_BOOTSTRAP_PREDECESSOR: JSON.stringify(changed) })).toBe(1);
      body = {
        ...body,
        stagingMaintenance: {
          ...maintenance,
          policySha256: previous.policySha256,
          window: { ...maintenance.window, recordedState: "completed" },
        },
      };
      expect(await main(["--force"], env)).toBe(0);
      expect(
        await main(["--force"], {
          ...env,
          RESIDENT_BOOTSTRAP_PREDECESSOR: JSON.stringify({ ...previous, policySha256: "0".repeat(64) }),
        }),
      ).toBe(1);
      body = {
        ...body,
        stagingMaintenance: { ...maintenance, window: { ...maintenance.window, recordedState: "authorized" } },
      };
      expect(await main(["--force"], env)).toBe(1);
      body = { ...body, stagingMaintenance: { ...maintenance, state: "held" } };
      expect(await main(["--force"], env)).toBe(1);
    } finally {
      wire.mockRestore();
      log.mockRestore();
      output.mockRestore();
    }
  });

  it("rechecks the selected readiness reserve at the final bootstrap preflight", async () => {
    const expected = "00000000-0000-4000-8000-000000000001";
    const wire = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(bootstrapFence(expected)));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const env = {
        RESIDENT_BASE_URL: "https://resident.example.test",
        RESIDENT_DRAIN_TOKEN: "fixture",
        RESIDENT_DEPLOY_ATTEMPT: JSON.stringify(attempt),
        RESIDENT_BOOTSTRAP_PREVIOUS_VERSION: expected,
        RESIDENT_BOOTSTRAP_RESOURCES: JSON.stringify(["repo:acme/api"]),
        RESIDENT_BOOTSTRAP_UPLOAD_RESERVE_MS: "1200000",
      };
      expect(await main(["--force"], env, { clock: () => attempt.deadline - 21 * 60_000 })).toBe(0);
      expect(await main(["--force"], env, { clock: () => attempt.deadline - 19 * 60_000 })).toBe(1);
    } finally {
      wire.mockRestore();
      log.mockRestore();
      output.mockRestore();
    }
  });

  it("never lets a selected bootstrap force an HTTP refusal or malformed response", async () => {
    for (const response of [
      ...[403, 404, 409, 500].map((status) => Response.json({ error: "refused" }, { status })),
      new Response("not JSON", { status: 200 }),
    ]) {
      const wire = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(
          await main(["--force"], {
            RESIDENT_BASE_URL: "https://resident.example.test",
            RESIDENT_DRAIN_TOKEN: "fixture",
            RESIDENT_DEPLOY_ATTEMPT: JSON.stringify(attempt),
            RESIDENT_BOOTSTRAP_PREVIOUS_VERSION: "00000000-0000-4000-8000-000000000001",
          }),
        ).toBe(1);
        expect(wire).toHaveBeenCalledTimes(1);
      } finally {
        wire.mockRestore();
        log.mockRestore();
      }
    }
  });

  it("refuses matching Worker identity without complete bootstrap member evidence", async () => {
    const wire = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        deployDiagnostic: {
          schema: 1,
          producer: {
            build: `${"b".repeat(40)}@2026-01-01T00:00:00Z`,
            workerVersion: "00000000-0000-4000-8000-000000000001",
          },
          fenceDisposition: "retained",
          admissionReadback: "reported",
        },
      }),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        await main(["--force"], {
          RESIDENT_BASE_URL: "https://resident.example.test",
          RESIDENT_DRAIN_TOKEN: "fixture",
          RESIDENT_DEPLOY_ATTEMPT: JSON.stringify(attempt),
          RESIDENT_BOOTSTRAP_PREVIOUS_VERSION: "00000000-0000-4000-8000-000000000001",
          RESIDENT_BOOTSTRAP_RESOURCES: JSON.stringify(["repo:acme/api"]),
        }),
      ).toBe(1);
    } finally {
      wire.mockRestore();
      log.mockRestore();
    }
  });

  it("refuses a selected-attempt HTTP denial even when force is requested", async () => {
    const wire = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ error: "selected attempt refused" }, { status: 409 }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        await main(["--force"], {
          RESIDENT_BASE_URL: "https://resident.example.test",
          RESIDENT_DRAIN_TOKEN: "synthetic-token",
          RESIDENT_DEPLOY_ATTEMPT: JSON.stringify(attempt),
        }),
      ).toBe(1);
    } finally {
      wire.mockRestore();
      log.mockRestore();
    }
  });

  it("accepts the selected exact attempt and refuses a borrowed or unverified exception", () => {
    expect(decide(received(), { attempt }).allow).toBe(true);
    expect(decide(received(), { attempt: { ...attempt, controllerId: "other-controller" } }).allow).toBe(false);
    expect(decide(received(), { force: true, attempt: { ...attempt, controllerId: "other-controller" } }).allow).toBe(
      false,
    );
    expect(decide(received()).allow).toBe(false);
    const changed = received();
    changed.payload.stagingMaintenance.window.originalRecordSha256 = null;
    expect(decide(changed, { attempt }).allow).toBe(false);
    expect(decide(payload([]), { attempt }).allow).toBe(false);
  });

  it("sends the selected attempt once and reports the preserved unknown request outcome", async () => {
    const requests = [];
    const lines = [];
    const wire = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      requests.push({ url, body: init.body });
      return Response.json(received().payload);
    });
    const log = vi.spyOn(console, "log").mockImplementation((line) => lines.push(line));
    const error = vi.spyOn(console, "error").mockImplementation((line) => lines.push(line));
    try {
      expect(
        await main([], {
          RESIDENT_BASE_URL: "https://resident.example.test",
          RESIDENT_DRAIN_TOKEN: "synthetic-token",
          RESIDENT_DEPLOY_ATTEMPT: JSON.stringify(attempt),
        }),
      ).toBe(0);
      expect(requests).toEqual([
        {
          url: "https://resident.example.test/deploy-fence",
          body: JSON.stringify({ attempt }),
        },
      ]);
      const line = lines.find((value) => value.startsWith("[resident-staging-maintenance] "));
      expect(line && JSON.parse(line.slice("[resident-staging-maintenance] ".length))).toMatchObject({
        disposition: "operator-abandoned",
        requestEnd: "unobserved",
        nativeOutcome: "unverified",
        stored: 1,
        excluded: 1,
        blocking: 0,
      });
      expect(lines.join("\n")).not.toContain("synthetic-token");
    } finally {
      wire.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe("resident deploy preflight — main()", () => {
  const operation = (suffix = "first") => ({
    key: `native-operation:http:fixture:run-original:${suffix}`,
    recordHash: "a".repeat(64),
    owner: { runId: "run-original", ownerGen: "generation-original", ownerFence: 3 },
    recoverable: false,
    recoveryReason: "original-native-evidence-unavailable",
    journal: { version: 1, closed: true, threadKey: "http:fixture", pending: { attempt: { kind: "opaque" } } },
    controls: [],
  });
  async function captured(operations, { cursor = null, failDiagnostic = false, unknownRuns = 1 } = {}) {
    const lines = [],
      requests = [];
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      requests.push({ url, method: init.method, headers: init.headers });
      return Response.json(
        payload([
          {
            resource: "repo:acme/api",
            live: {
              state: "warm",
              inFlight: 0,
              executingRuns: 0,
              retainedRuns: 0,
              unknownRuns,
              nativeOperationReadback: { operations, cursor },
            },
          },
        ]).payload,
      );
    });
    const logger = vi.spyOn(console, "error").mockImplementation((line) => {
      if (failDiagnostic && line.startsWith("[resident-native-operation-diagnostic]"))
        throw new Error("synthetic sink failure");
      lines.push(line);
    });
    const normal = vi.spyOn(console, "log").mockImplementation((line) => lines.push(line));
    try {
      const code = await main([], {
        RESIDENT_BASE_URL: "https://resident.example.test",
        RESIDENT_DRAIN_TOKEN: "synthetic-token",
      });
      const line = lines.find((line) => line.startsWith("[resident-native-operation-diagnostic] "));
      return {
        code,
        lines,
        requests,
        diagnostic: line ? JSON.parse(line.slice("[resident-native-operation-diagnostic] ".length)) : null,
      };
    } finally {
      fetcher.mockRestore();
      logger.mockRestore();
      normal.mockRestore();
    }
  }

  it("captures original hashes and unresolved attempt kinds from the same refusal response", async () => {
    const second = operation("second");
    second.journal.pending = { attempt: { kind: "process" } };
    const actual = await captured([operation(), second]);
    expect(actual.code).toBe(1);
    expect(actual.requests).toEqual([
      {
        url: "https://resident.example.test/deploy-fence",
        method: "POST",
        headers: { authorization: "Bearer synthetic-token" },
      },
    ]);
    expect(actual.diagnostic).toEqual({
      schema: 1,
      receivedProjectionComplete: true,
      controlStorageCompleteness: "unverified",
      omittedResourceCount: 0,
      resources: [
        {
          resource: "repo:acme/api",
          returnedOperationCount: 2,
          operationCursor: null,
          omittedOperationCount: 0,
          operations: [
            { ...operation(), controls: undefined, returnedControls: [] },
            { ...second, controls: undefined, returnedControls: [] },
          ].map(({ controls: _controls, ...row }) => row),
        },
      ],
    });
    expect(actual.lines.at(-1)).toContain("preflight REFUSED");
    expect(actual.lines.join("\n")).not.toContain("synthetic-token");
  });

  it("retains original process and returned control receipts without exposing extra fields", async () => {
    const row = operation();
    const process = { id: "process-original", pid: 42, startedAt: "2026-01-01T00:00:00Z" };
    row.journal.pending = { attempt: { kind: "process", process } };
    row.controls = [
      {
        process,
        recordHash: "b".repeat(64),
        outcome: "kill-unverified",
        failure: { class: "Error", code: "ECONNRESET" },
      },
    ];
    row.secret = "do-not-retain";
    row.journal.environment = { TOKEN: "do-not-retain" };
    const actual = await captured([row]);
    expect(actual.diagnostic.resources[0].operations[0]).toMatchObject({
      recordHash: "a".repeat(64),
      journal: { closed: true, pending: { attempt: { kind: "process", process } } },
      returnedControls: row.controls,
    });
    expect(actual.diagnostic.controlStorageCompleteness).toBe("unverified");
    expect(actual.lines.join("\n")).not.toContain("do-not-retain");
  });

  it("reports malformed whole details and received-page omissions as incomplete", async () => {
    const row = operation();
    row.journal.pending = { attempt: { kind: "unknown", secret: "do-not-retain" } };
    const actual = await captured([row, ...Array.from({ length: 5 }, (_, i) => operation(`extra-${i}`))], {
      cursor: "native-operation:http:fixture:run-original:next",
    });
    expect(actual.code).toBe(1);
    expect(actual.requests).toHaveLength(1);
    expect(actual.diagnostic).toMatchObject({
      receivedProjectionComplete: false,
      resources: [
        {
          operationCursor: "native-operation:http:fixture:run-original:next",
          returnedOperationCount: 6,
          omittedOperationCount: 1,
        },
      ],
    });
    expect(actual.diagnostic.resources[0].operations[0]).toEqual({
      key: row.key,
      recordHash: row.recordHash,
      detailUnavailable: "malformed",
    });
    expect(actual.diagnostic.resources[0].operations).toHaveLength(5);
    expect(actual.lines.join("\n")).not.toContain("do-not-retain");
  });

  it("never truncates a pending map or returned controls into complete evidence", async () => {
    for (const kind of ["pending", "controls"]) {
      const row = operation();
      if (kind === "pending")
        row.journal.pending = Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [`attempt-${i}`, { kind: "opaque" }]),
        );
      else
        row.controls = Array.from({ length: 65 }, () => ({
          process: { id: "process", pid: 42, startedAt: "2026-01-01T00:00:00Z" },
          recordHash: "b".repeat(64),
          outcome: "requested",
        }));
      const actual = await captured([row]);
      expect(actual.code).toBe(1);
      expect(actual.diagnostic).toMatchObject({
        receivedProjectionComplete: false,
        resources: [{ operations: [{ key: row.key, recordHash: row.recordHash, detailUnavailable: "malformed" }] }],
      });
    }
  });

  it("labels all returned controls without claiming complete control storage", async () => {
    const row = operation();
    row.controls = Array.from({ length: 64 }, () => ({
      process: { id: "p", pid: 42, startedAt: "2026-01-01T00:00:00Z" },
      recordHash: "b".repeat(64),
      outcome: "requested",
    }));
    const actual = await captured([row]);
    expect(actual.code).toBe(1);
    expect(actual.diagnostic).toMatchObject({
      receivedProjectionComplete: true,
      controlStorageCompleteness: "unverified",
    });
    expect(actual.diagnostic.resources[0].operations[0].returnedControls).toEqual(row.controls);
  });

  it("keeps the capture within its byte budget and marks omitted whole details", async () => {
    const row = operation();
    row.journal.pending = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [
        `attempt-${i}`,
        { kind: "process", process: { id: "p".repeat(256), pid: 42, startedAt: "2026-01-01T00:00:00Z" } },
      ]),
    );
    const actual = await captured([row]);
    expect(actual.code).toBe(1);
    expect(actual.diagnostic).toMatchObject({
      receivedProjectionComplete: false,
      resources: [{ operations: [{ key: row.key, recordHash: row.recordHash, detailUnavailable: "byte-limit" }] }],
    });
    expect(
      Buffer.byteLength(actual.lines.find((line) => line.startsWith("[resident-native-operation-diagnostic]"))) + 1,
    ).toBeLessThanOrEqual(16384);
  });

  it("preserves refusal when diagnostic writing fails and emits nothing on clean admission", async () => {
    const failed = await captured([operation()], { failDiagnostic: true });
    expect(failed.code).toBe(1);
    expect(failed.lines.at(-1)).toContain("preflight REFUSED");
    const clean = await captured([], { unknownRuns: 0 });
    expect(clean.code).toBe(0);
    expect(clean.lines).toHaveLength(1);
    expect(clean.lines[0]).toContain("preflight ok");
    expect(clean.requests).toHaveLength(1);
  });
  it(`refuses (exit 2) before reading anything when ${BASE_URL_ENV} is not set — the Worker's origin is the deployment profile's, handed over by deploy all`, async () => {
    const errors = [];
    const original = console.error;
    console.error = (line) => errors.push(String(line));
    try {
      expect(await main([], { RESIDENT_READ_TOKEN: "r" })).toBe(2);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain(`${BASE_URL_ENV} is not set`);
    expect(errors.join("\n")).toContain("deploy all");
  });
});

describe("resident deploy admission diagnostic", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const row = {
    id,
    startedAt: 1000,
    schema: 1,
    kind: "watchdog",
    component: "scheduler",
    build: "a".repeat(40),
    workerVersion: "00000000-0000-4000-8000-000000000002",
    resource: null,
    sourceId: null,
    traceId: "b".repeat(32),
    requesterScope: null,
  };
  async function captured(body, responseStatus = 200) {
    const lines = [],
      requests = [];
    const log = vi.spyOn(console, "error").mockImplementation((line) => lines.push(String(line)));
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requests.push(init.method);
      return responseStatus === 200
        ? Response.json(body)
        : new Response("private-token /workspace/private raw exception", { status: responseStatus });
    });
    try {
      const code = await main([], {
        RESIDENT_BASE_URL: "https://resident.example.test",
        RESIDENT_DRAIN_TOKEN: "synthetic-token",
      });
      const line = lines.find((v) => v.startsWith("[resident-deploy-admission-diagnostic] "));
      return {
        code,
        lines,
        requests,
        diagnostic: line ? JSON.parse(line.slice("[resident-deploy-admission-diagnostic] ".length)) : null,
      };
    } finally {
      log.mockRestore();
      fetcher.mockRestore();
    }
  }
  const refused = (rows) => ({
    ...payload([]).payload,
    activeAdmissions: rows.length,
    fenceReady: false,
    admissionReadback: { schema: 1, observedAt: 2000, observedActiveCount: rows.length, omittedCount: 0, rows },
  });

  it("names an internal permit on the first refusal without inventing a model run", async () => {
    const result = await captured(refused([row]));
    expect({ code: result.code, requests: result.requests }).toEqual({ code: 1, requests: ["POST"] });
    expect(result.diagnostic).toMatchObject({
      schema: 1,
      receivedProjectionComplete: true,
      observedActiveCount: 1,
      rows: [
        {
          id,
          kind: "watchdog",
          component: "scheduler",
          startedAt: 1000,
          resource: null,
          traceId: "b".repeat(32),
          requesterScope: null,
          requestEnd: "unobserved",
          nativeOutcome: "unverified",
          expiry: "none",
        },
      ],
    });
  });

  it("retains the blocking snapshot when the final admission count becomes zero", async () => {
    const body = refused([row]);
    body.activeAdmissions = 0;
    const result = await captured(body);
    expect({ code: result.code, requests: result.requests }).toEqual({ code: 1, requests: ["POST"] });
    expect(result.diagnostic).toMatchObject({
      gateActiveCount: 0,
      observedActiveCount: 1,
      countMatchesGate: false,
      receivedProjectionComplete: false,
      rows: [{ id, startedAt: 1000, kind: "watchdog" }],
    });
  });

  it("marks legacy and missing metadata explicitly while retaining refusal", async () => {
    const result = await captured(refused([{ id, startedAt: 1000, kind: "unknown" }]));
    expect({ code: result.code, row: result.diagnostic?.rows[0] }).toEqual({
      code: 1,
      row: { id, startedAt: 1000, detailUnavailable: "legacy" },
    });
    const missing = await captured({ ...payload([]).payload, activeAdmissions: 1, fenceReady: false });
    expect(missing.diagnostic).toMatchObject({
      receivedProjectionComplete: false,
      detailUnavailable: "producer-field-absent",
    });
  });

  it("does not release old or foreign permits and states snapshot mismatch", async () => {
    const body = refused([{ ...row, startedAt: 1, workerVersion: "00000000-0000-4000-8000-000000000003" }]);
    body.activeAdmissions = 2;
    body.draining.until = new Date(0).toISOString();
    const result = await captured(body);
    expect({ code: result.code, requests: result.requests }).toEqual({ code: 1, requests: ["POST"] });
    expect(result.diagnostic).toMatchObject({
      receivedProjectionComplete: false,
      countMatchesGate: false,
      rows: [{ id, startedAt: 1, expiry: "none", workerVersion: "00000000-0000-4000-8000-000000000003" }],
    });
  });

  it("bounds and redacts the diagnostic instead of copying arbitrary metadata", async () => {
    const rows = Array.from({ length: 8 }, () => ({
      ...row,
      token: "private-token",
      exception: "private-error",
      path: "/workspace/private",
    }));
    rows[0].sourceId = "/workspace/private";
    const result = await captured(refused(rows));
    expect(result.diagnostic).toMatchObject({ receivedProjectionComplete: false, omittedCount: 3 });
    expect(result.diagnostic.rows).toHaveLength(5);
    expect(result.diagnostic.rows[0]).toEqual({ id, startedAt: 1000, detailUnavailable: "malformed" });
    expect(result.lines.join("\n")).not.toContain("private-");
    expect(result.lines.join("\n")).not.toContain("/workspace/");
    expect(Buffer.byteLength(JSON.stringify(result.diagnostic))).toBeLessThanOrEqual(8192);
  });

  it("keeps refusal when the global diagnostic sink fails", async () => {
    const body = refused([row]);
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
    const lines = [];
    const logger = vi.spyOn(console, "error").mockImplementation((line) => {
      if (String(line).startsWith("[resident-deploy-admission-diagnostic]")) throw new Error("private-sink-error");
      lines.push(String(line));
    });
    try {
      expect(
        await main([], { RESIDENT_BASE_URL: "https://resident.example.test", RESIDENT_DRAIN_TOKEN: "synthetic-token" }),
      ).toBe(1);
      expect(lines.at(-1)).toContain("1 resident operation(s) admitted before the fence remain active");
    } finally {
      fetcher.mockRestore();
      logger.mockRestore();
    }
    const incomplete = await captured(refused([{ ...row, kind: null }]));
    expect(incomplete.diagnostic.rows[0]).toEqual({ id, startedAt: 1000, detailUnavailable: "incomplete" });
  });

  it("keeps malformed successful responses closed without printing private error data", async () => {
    const result = await captured({
      ...payload([]).payload,
      fenceReady: false,
      residents: [
        { resource: "repo:acme/api", live: { error: "private-token /workspace/private" } },
        {
          resource: "/workspace/private",
          live: {
            state: "private-token",
            inFlight: 0,
            runsInFlight: 0,
            executingRuns: 0,
            retainedRuns: 0,
            unknownRuns: 0,
          },
        },
      ],
    });
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("resident-view-unavailable");
    expect(result.lines.join("\n")).not.toContain("private-token");
    expect(result.lines.join("\n")).not.toContain("/workspace/private");
  });

  it("distinguishes omitted producer metadata from a failed read without claiming upgrade", async () => {
    const missing = await captured({ ...payload([]).payload, activeAdmissions: 1, fenceReady: false });
    expect(missing.diagnostic).toMatchObject({
      detailUnavailable: "producer-field-absent",
      producer: { state: "unverified" },
    });
    const failed = await captured({
      ...payload([]).payload,
      activeAdmissions: 1,
      fenceReady: false,
      admissionReadback: null,
      deployDiagnostic: {
        schema: 1,
        producer: { build: "a".repeat(40), workerVersion: "00000000-0000-4000-8000-000000000002" },
        fenceDisposition: "withdrawn",
        admissionReadback: "unavailable",
      },
    });
    expect(failed.diagnostic).toMatchObject({
      detailUnavailable: "readback-unavailable",
      fenceDisposition: "withdrawn",
      producer: { state: "reported", build: "a".repeat(40) },
    });
  });

  it("names a withdrawn fence without turning that metadata into upload authority", async () => {
    const body = refused([row]);
    body.draining.swapFence = false;
    body.deployDiagnostic = {
      schema: 1,
      producer: { build: "a".repeat(40), workerVersion: "00000000-0000-4000-8000-000000000002" },
      fenceDisposition: "withdrawn",
      admissionReadback: "reported",
    };
    const result = await captured(body);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("deploy fence was withdrawn after the activity check refused upload");
    expect(result.lines.join("\n")).not.toContain("missing or invalid");
    body.fenceReady = true;
    expect(decide({ ok: true, payload: body }).allow).toBe(false);
  });

  it("reports a closed HTTP failure without response bytes or the credential", async () => {
    const result = await captured(null, 403);
    expect({ code: result.code, requests: result.requests }).toEqual({ code: 1, requests: ["POST"] });
    expect(result.lines.join("\n")).toContain("http-status:403");
    expect(result.lines.join("\n")).not.toContain("private-");
    expect(result.lines.join("\n")).not.toContain("/workspace/");
    expect(result.lines.join("\n")).not.toContain("synthetic-token");
  });
});

const payload = (residents) => ({
  ok: true,
  payload: {
    fenceReady: true,
    activeAdmissions: 0,
    draining: {
      since: new Date(Date.now() - 1000).toISOString(),
      until: new Date(Date.now() + 60_000).toISOString(),
      swapFence: true,
    },
    cap: 8,
    count: residents.length,
    inFlight: residents.reduce((a, r) => a + (r.live?.inFlight ?? 0), 0),
    residents: residents.map((r) => ({
      ...r,
      live: r.live
        ? {
            executingRuns: r.live.runsInFlight ?? r.live.inFlight,
            retainedRuns: 0,
            unknownRuns: 0,
            ...r.live,
            runsInFlight: r.live.runsInFlight ?? r.live.inFlight,
          }
        : r.live,
    })),
  },
});
const resident = (resource, inFlight) => ({ resource, live: { state: "warm", inFlight } });

describe("resident deploy preflight — decide()", () => {
  it("keeps malformed operation metadata unavailable without relaxing the hold", () => {
    const result = decide(
      payload([
        {
          resource: "repo:acme/api",
          live: {
            state: "warm",
            inFlight: 1,
            executingRuns: 0,
            retainedRuns: 0,
            unknownRuns: 1,
            registrationReadback: [],
            nativeOperationReadback: { operations: [null], cursor: null },
          },
        },
      ]),
    );
    expect(result.allow).toBe(false);
    expect(result.unknown).toEqual([
      {
        resource: "repo:acme/api",
        error: "1 run/operation hold(s) unverified; registration readback: empty; operation readback: unavailable",
      },
    ]);
  });

  it("names the held operation and original process instead of guessing that its run owner is unknown", () => {
    const result = decide(
      payload([
        {
          resource: "repo:acme/api",
          live: {
            state: "warm",
            inFlight: 1,
            executingRuns: 0,
            retainedRuns: 0,
            unknownRuns: 1,
            registrationReadback: [],
            nativeOperationReadback: {
              operations: [
                {
                  key: "native-operation:op:original",
                  recoveryReason: "original-process-result-required",
                  journal: { pending: { attempt: { kind: "process", process: { id: "original-process", pid: 42 } } } },
                },
              ],
              cursor: null,
            },
          },
        },
      ]),
    );
    expect(result.allow).toBe(false);
    expect(result.unknown).toEqual([
      {
        resource: "repo:acme/api",
        error:
          "1 run/operation hold(s) unverified; registration readback: empty; operation readback: 1 stored hold(s); native-operation:op:original [original-process-result-required; processes=original-process/pid=42]",
      },
    ]);
  });

  it.each([
    [
      "unknown",
      "malformed-registration",
      "1 run/operation hold(s) unverified; registration readback: unknown/malformed-registration=1",
    ],
    [
      "unknown",
      "owner-unverified",
      "1 run/operation hold(s) unverified; registration readback: unknown/owner-unverified=1",
    ],
    [
      "unknown",
      "binding-conflict",
      "1 run/operation hold(s) unverified; registration readback: unknown/binding-conflict=1",
    ],
    [
      "unknown",
      "ledger-unverified",
      "1 run/operation hold(s) unverified; registration readback: unknown/ledger-unverified=1",
    ],
    [
      "legacy",
      "operation-active",
      "1 run/operation hold(s) unverified; registration readback: legacy/operation-active=1",
    ],
    [
      "legacy",
      "legacy-protected",
      "1 run/operation hold(s) unverified; registration readback: legacy/legacy-protected=1",
    ],
    [
      "legacy",
      "protection-elapsed",
      "1 run/operation hold(s) unverified; registration readback: legacy/protection-elapsed=1",
    ],
    [
      "legacy",
      "legacy-reconciled",
      "1 run/operation hold(s) unverified; registration readback: legacy/legacy-reconciled=1",
    ],
    ["owned", "live-owner", "1 run/operation hold(s) unverified; registration readback: owned/live-owner=1"],
    ["owned", "terminal-owner", "1 run/operation hold(s) unverified; registration readback: owned/terminal-owner=1"],
  ])("renders only registered readback pairs: %s/%s", (category, reason, expected) => {
    const d = decide(
      payload([
        {
          resource: "repo:acme/widgets",
          live: {
            state: "warm",
            inFlight: 1,
            runsInFlight: 1,
            executingRuns: 0,
            retainedRuns: 0,
            unknownRuns: 1,
            registrationReadback: [{ category, reason, count: 1, extra: "private-secret" }],
          },
        },
      ]),
    );
    expect(d.allow).toBe(false);
    expect(d.unknown).toEqual([{ resource: "repo:acme/widgets", error: expected }]);
    expect(d.message).not.toContain("private-secret");
  });

  it.each(
    [
      undefined,
      null,
      "private-readback",
      {},
      [null],
      [[]],
      [{ category: "private-category", reason: "ledger-unverified", count: 1 }],
      [{ category: "unknown", reason: "private-reason", count: 1 }],
      [{ category: { toString: 1, valueOf: 1 }, reason: "ledger-unverified", count: 1 }],
      [{ category: "unknown", reason: { toString: 1 }, count: 1 }],
      [{ category: "owned", reason: "ledger-unverified", count: 1 }],
      [{ category: "none", reason: "no-registration", count: 1 }],
      ...[undefined, "private-count", NaN, Infinity, 0.5, -1, 0, Number.MAX_SAFE_INTEGER + 1].map((count) => [
        { category: "unknown", reason: "ledger-unverified", count },
      ]),
      Array.from({ length: 2 }, () => ({ category: "unknown", reason: "ledger-unverified", count: 1 })),
      Array.from({ length: 11 }, () => ({ category: "unknown", reason: "ledger-unverified", count: 1 })),
    ].map((readback) => [readback]),
  )("keeps malformed or missing readback unavailable: %#", (registrationReadback) => {
    const d = decide(
      payload([
        {
          resource: "repo:acme/widgets",
          live: {
            state: "warm",
            inFlight: 1,
            runsInFlight: 1,
            executingRuns: 0,
            retainedRuns: 0,
            unknownRuns: 1,
            registrationReadback,
          },
        },
      ]),
    );
    expect({ allow: d.allow, forced: d.forced, unknown: d.unknown }).toEqual({
      allow: false,
      forced: false,
      unknown: [
        {
          resource: "repo:acme/widgets",
          error: "1 run/operation hold(s) unverified; registration readback: unavailable",
        },
      ],
    });
    expect(d.message).not.toContain("private-");
  });

  it("reports empty readback as empty without classifying unknown work", () => {
    const d = decide(
      payload([
        {
          resource: "repo:acme/widgets",
          live: {
            state: "warm",
            inFlight: 1,
            runsInFlight: 1,
            executingRuns: 0,
            retainedRuns: 0,
            unknownRuns: 1,
            registrationReadback: [],
          },
        },
      ]),
    );
    expect({ allow: d.allow, unknown: d.unknown }).toEqual({
      allow: false,
      unknown: [
        { resource: "repo:acme/widgets", error: "1 run/operation hold(s) unverified; registration readback: empty" },
      ],
    });
  });

  it("reports the closed unknown registration reason while main still exits refused", async () => {
    const fetched = payload([
      {
        resource: "repo:acme/widgets",
        live: {
          state: "warm",
          inFlight: 1,
          runsInFlight: 1,
          executingRuns: 0,
          retainedRuns: 0,
          unknownRuns: 1,
          registrationReadback: [
            {
              category: "unknown",
              reason: "ledger-unverified",
              count: 1,
              runId: "private-run",
              ownerGen: "private-owner",
              token: "private-token",
            },
          ],
        },
      },
    ]);
    fetched.payload.draining.swapFence = false;
    fetched.payload.fenceReady = false;
    const d = decide(fetched);
    expect({ allow: d.allow, forced: d.forced, unknown: d.unknown }).toEqual({
      allow: false,
      forced: false,
      unknown: [
        {
          resource: "repo:acme/widgets",
          error: "1 run/operation hold(s) unverified; registration readback: unknown/ledger-unverified=1",
        },
      ],
    });
    const lines = [];
    const logger = vi.spyOn(console, "error").mockImplementation((line) => lines.push(String(line)));
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(fetched.payload), { status: 200 }));
    try {
      expect(
        await main([], { RESIDENT_BASE_URL: "https://resident.invalid", RESIDENT_DRAIN_TOKEN: "private-token" }),
      ).toBe(1);
      expect(lines.join("\n")).toContain("unknown/ledger-unverified=1");
      expect(lines.join("\n")).not.toContain("private-");
    } finally {
      logger.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("retained terminal registrations do not count as executing under a closed deploy fence", () => {
    const d = decide({
      ok: true,
      payload: {
        fenceReady: true,
        activeAdmissions: 0,
        draining: {
          since: new Date(Date.now() - 1000).toISOString(),
          until: new Date(Date.now() + 60_000).toISOString(),
          swapFence: true,
        },
        residents: [
          {
            resource: "repo:acme/widgets",
            live: { state: "warm", inFlight: 3, runsInFlight: 3, executingRuns: 0, retainedRuns: 3, unknownRuns: 0 },
          },
        ],
      },
    });
    expect(d.allow).toBe(true);
    expect(d.busy).toEqual([]);
    expect(d.message).toContain("3 retained");
  });

  it("allows only a categorized elapsed legacy row behind a ready fence and refuses malformed or protected rows", () => {
    const live = {
      state: "warm",
      inFlight: 0,
      runsInFlight: 0,
      executingRuns: 0,
      retainedRuns: 1,
      unknownRuns: 0,
      registrationReadback: [{ category: "legacy", reason: "protection-elapsed", count: 1 }],
    };
    const elapsed = payload([{ resource: "repo:x/y", live }]);
    expect(decide(elapsed).allow).toBe(true);
    expect(decide({ ...elapsed, payload: { ...elapsed.payload, fenceReady: false } }).allow).toBe(false);
    for (const reason of ["malformed-registration", "legacy-protected"]) {
      const unverified = payload([
        {
          resource: "repo:x/y",
          live: {
            ...live,
            retainedRuns: 0,
            unknownRuns: 1,
            registrationReadback: [
              { category: reason === "legacy-protected" ? "legacy" : "unknown", reason, count: 1 },
            ],
          },
        },
      ]);
      expect(decide(unverified).allow).toBe(false);
    }
    expect(
      decide(payload([{ resource: "repo:x/y", live: { ...live, retainedRuns: 0, executingRuns: 1 } }])).allow,
    ).toBe(false);
  });

  it("refuses unclassified protected activity but permits an operation to overlap a retained registration", () => {
    const missed = decide(
      payload([
        {
          resource: "repo:x/y",
          live: { state: "warm", inFlight: 3, runsInFlight: 3, executingRuns: 0, retainedRuns: 2, unknownRuns: 0 },
        },
      ]),
    );
    expect(missed.allow).toBe(false);
    expect(missed.unknown[0].error).toContain("misses a protected run");
    const overlapping = decide(
      payload([
        {
          resource: "repo:x/y",
          live: { state: "warm", inFlight: 1, runsInFlight: 1, executingRuns: 1, retainedRuns: 1, unknownRuns: 0 },
        },
      ]),
    );
    expect(overlapping.allow).toBe(false);
    expect(overlapping.busy).toEqual([{ resource: "repo:x/y", inFlight: 1 }]);
    expect(overlapping.unknown).toEqual([]);
  });

  it("refuses retained work without a live fence, an executing owner, or unknown ownership", () => {
    const retained = payload([
      {
        resource: "repo:x/y",
        live: { state: "warm", inFlight: 3, runsInFlight: 3, executingRuns: 0, retainedRuns: 3, unknownRuns: 0 },
      },
    ]);
    expect(decide({ ...retained, payload: { ...retained.payload, draining: null } }).allow).toBe(false);
    expect(decide({ ...retained, payload: { ...retained.payload, fenceReady: false } }).allow).toBe(false);
    const admitted = decide({ ...retained, payload: { ...retained.payload, activeAdmissions: 1 } });
    expect(admitted.allow).toBe(false);
    expect(admitted.message).toContain("operation(s) admitted before the fence");
    expect(
      decide({
        ...retained,
        payload: { ...retained.payload, draining: { ...retained.payload.draining, until: "2000-01-01T00:00:00Z" } },
      }).allow,
    ).toBe(false);
    expect(
      decide(
        payload([
          {
            resource: "repo:x/y",
            live: { state: "warm", inFlight: 4, runsInFlight: 4, executingRuns: 1, retainedRuns: 3, unknownRuns: 0 },
          },
        ]),
      ).allow,
    ).toBe(false);
    expect(
      decide(
        payload([
          {
            resource: "repo:x/y",
            live: { state: "warm", inFlight: 3, runsInFlight: 3, executingRuns: 0, retainedRuns: 2, unknownRuns: 1 },
          },
        ]),
      ).allow,
    ).toBe(false);
  });

  it("idle everywhere → allow, not forced", () => {
    const d = decide(payload([resident("repo:jshttp/vary", 0), resident("repo:acme/widgets", 0)]));
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(false);
    expect(d.busy).toEqual([]);
    expect(d.message).toMatch(/no resident has work in flight/);
  });

  it("no residents onboarded → allow", () => {
    const d = decide(payload([]));
    expect(d.allow).toBe(true);
    expect(d.message).toMatch(/0 residents/);
  });

  it("busy → refuse, naming every busy resident with its count", () => {
    const d = decide(
      payload([resident("repo:jshttp/vary", 0), resident("repo:acme/widgets", 2), resident("repo:a/b", 1)]),
    );
    expect(d.allow).toBe(false);
    expect(d.busy).toEqual([
      { resource: "repo:acme/widgets", inFlight: 2 },
      { resource: "repo:a/b", inFlight: 1 },
    ]);
    expect(d.message).toContain("repo:acme/widgets (2 in flight)");
    expect(d.message).toContain("repo:a/b (1 in flight)");
    expect(d.message).not.toContain("repo:jshttp/vary");
    expect(d.message).toMatch(/RESIDENT_DEPLOY_FORCE=1/);
  });

  // A deploy swaps every ResidentDO isolate; a refresh cycle's fetch/rebuild
  // or a restore in progress is killed just like a thread run (seen live:
  // `degraded(build-failed: exit 143: Session terminated)` on repo:acme/widgets
  // right after a deploy that passed preflight).
  it("a resident provisioning (onboarding) → refuse, naming the state, even with 0 in flight: an isolate swap fails the provision and only a rebuild recovers it", () => {
    const d = decide(
      payload([
        resident("repo:jshttp/vary", 0),
        { resource: "repo:acme/widgets", live: { state: "onboarding", inFlight: 0 } },
      ]),
    );
    expect(d.allow).toBe(false);
    expect(d.provisioning).toEqual([{ resource: "repo:acme/widgets", state: "onboarding" }]);
    expect(d.interrupting).toEqual([]);
    expect(d.message).toContain("repo:acme/widgets (onboarding)");
    expect(d.message).toMatch(/RESIDENT_DEPLOY_FORCE=1/);
  });

  it("a resident refreshing or restoring with 0 in flight → allow with a WARNING naming the state: the refresh instance retries the step after the swap (item 44), a restore is retried by the next hydrate (item 61)", () => {
    for (const state of ["refreshing", "restoring"]) {
      const d = decide(
        payload([resident("repo:jshttp/vary", 0), { resource: "repo:acme/widgets", live: { state, inFlight: 0 } }]),
      );
      expect(d.allow, state).toBe(true);
      expect(d.forced).toBe(false);
      expect(d.provisioning).toEqual([]);
      expect(d.interrupting).toEqual([{ resource: "repo:acme/widgets", state }]);
      expect(d.message).toMatch(/^preflight ok:/);
      expect(d.message).toContain("WARNING");
      expect(d.message).toContain(`repo:acme/widgets (${state})`);
      expect(d.message).not.toContain("REFUSED");
    }
  });

  it("warm / degraded / down with 0 in flight are not mid-cycle → allow", () => {
    const d = decide(
      payload([
        { resource: "repo:a/b", live: { state: "warm", inFlight: 0 } },
        { resource: "repo:c/d", live: { state: "degraded", reason: "github-unreachable: x", inFlight: 0 } },
        { resource: "repo:e/f", live: { state: "down", reason: "provision-failed at clone: y", inFlight: 0 } },
      ]),
    );
    expect(d.allow).toBe(true);
    expect(d.provisioning).toEqual([]);
  });

  it("busy AND mid-cycle are both reported — neither shadows the other; runs in flight refuse even when the cycle alone would only warn", () => {
    const d = decide(payload([{ resource: "repo:x/y", live: { state: "onboarding", inFlight: 2 } }]));
    expect(d.allow).toBe(false);
    expect(d.busy).toEqual([{ resource: "repo:x/y", inFlight: 2 }]);
    expect(d.provisioning).toEqual([{ resource: "repo:x/y", state: "onboarding" }]);
    expect(d.message).toContain("repo:x/y (2 in flight)");
    expect(d.message).toContain("repo:x/y (onboarding)");
    const refreshingBusy = decide(payload([{ resource: "repo:x/y", live: { state: "refreshing", inFlight: 1 } }]));
    expect(refreshingBusy.allow).toBe(false);
    expect(refreshingBusy.interrupting).toEqual([{ resource: "repo:x/y", state: "refreshing" }]);
    expect(refreshingBusy.message).toContain("repo:x/y (1 in flight)");
  });

  it("`executingRuns` decides busy under the fence: a refreshing resident whose only in-flight work is its cycle allows with a warning; a run refuses", () => {
    const cycleOnly = decide(
      payload([{ resource: "repo:x/y", live: { state: "refreshing", inFlight: 1, runsInFlight: 0 } }]),
    );
    expect(cycleOnly.allow).toBe(true);
    expect(cycleOnly.busy).toEqual([]);
    expect(cycleOnly.interrupting).toEqual([{ resource: "repo:x/y", state: "refreshing" }]);
    expect(cycleOnly.message).toMatch(/^preflight ok:/);
    expect(cycleOnly.message).toContain("WARNING");
    const withRun = decide(
      payload([{ resource: "repo:x/y", live: { state: "refreshing", inFlight: 2, runsInFlight: 1 } }]),
    );
    expect(withRun.allow).toBe(false);
    expect(withRun.busy).toEqual([{ resource: "repo:x/y", inFlight: 1 }]);
    expect(withRun.message).toContain("repo:x/y (1 in flight)");
    const bad = decide(payload([{ resource: "repo:x/y", live: { state: "warm", inFlight: 0, runsInFlight: -1 } }]));
    expect(bad.allow).toBe(false);
    expect(bad.unknown[0].error).toContain("runsInFlight=-1");
  });

  // Allow-list of settled states: this script is plain JS outside the shared
  // ResidentLifecycleState type, so a state it has never heard of must fail
  // closed rather than be assumed idle.
  it("an unrecognized lifecycle state is unknown → refuse (fail closed on vocabulary drift)", () => {
    const d = decide(payload([{ resource: "repo:x/y", live: { state: "hibernating", inFlight: 0 } }]));
    expect(d.allow).toBe(false);
    expect(d.provisioning).toEqual([]);
    expect(d.unknown).toEqual([
      {
        resource: "repo:x/y",
        error: "live view carries an unrecognized state (vocabulary drift — update preflight.mjs)",
      },
    ]);
  });

  it("force overrides a provisioning — allowed, flagged, and the warning names the state", () => {
    const d = decide(payload([{ resource: "repo:x/y", live: { state: "onboarding", inFlight: 0 } }]), { force: true });
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(true);
    expect(d.message).toContain("repo:x/y (onboarding)");
  });

  it("a resident whose live view failed is unknown → refuse (fail closed)", () => {
    const d = decide(
      payload([resident("repo:jshttp/vary", 0), { resource: "repo:x/y", live: { error: "DO timed out" } }]),
    );
    expect(d.allow).toBe(false);
    expect(d.unknown).toEqual([{ resource: "repo:x/y", error: "resident-view-unavailable" }]);
    expect(d.message).toContain("repo:x/y");
    expect(d.message).toContain("resident-view-unavailable");
  });

  it("a payload without per-resident inFlight (old Worker) is unknown → refuse", () => {
    const d = decide({ ok: true, payload: { residents: [{ resource: "repo:x/y", live: { state: "warm" } }] } });
    expect(d.allow).toBe(false);
    expect(d.unknown[0].resource).toBe("repo:x/y");
  });

  it("a negative or non-integer inFlight (counter bug) is unknown, never idle → refuse", () => {
    for (const bad of [-1, 0.5, NaN, Infinity]) {
      const d = decide(payload([resident("repo:x/y", bad)]));
      expect(d.allow, `inFlight=${bad}`).toBe(false);
      expect(d.busy).toEqual([]);
      expect(d.unknown[0].resource).toBe("repo:x/y");
      expect(d.message).toContain(`inFlight=${bad}`);
    }
  });

  it("malformed payload → refuse", () => {
    expect(decide({ ok: true, payload: null }).allow).toBe(false);
    expect(decide({ ok: true, payload: { residents: "nope" } }).allow).toBe(false);
    expect(decide(undefined).allow).toBe(false);
  });

  it("unreachable / no token → refuse with the operator hint", () => {
    const d = decide({ ok: false, error: "no bearer in the environment" });
    expect(d.allow).toBe(false);
    expect(d.message).toContain("no bearer in the environment");
    expect(d.message).toMatch(/RESIDENT_DRAIN_TOKEN/);
    expect(d.message).toMatch(/RESIDENT_DEPLOY_FORCE=1/);
  });

  it("force overrides busy — allowed, flagged, and the warning still names the busy residents", () => {
    const d = decide(payload([resident("repo:acme/widgets", 1)]), { force: true });
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(true);
    expect(d.message).toMatch(/WARNING/);
    expect(d.message).toContain("repo:acme/widgets (1 in flight)");
  });

  it("force overrides unreachable — allowed and flagged", () => {
    const d = decide({ ok: false, error: "fetch failed" }, { force: true });
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(true);
    expect(d.message).toMatch(/WARNING/);
    expect(d.message).toContain("fetch failed");
  });

  it("force on an idle fleet is a plain allow, not flagged", () => {
    const d = decide(payload([resident("repo:jshttp/vary", 0)]), { force: true });
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(false);
  });
});

describe("readToken()", () => {
  it("uses the drain bearer; read, operator, and admin bearers cannot replace the runner's drain", () => {
    expect(readToken({ RESIDENT_DRAIN_TOKEN: "d", RESIDENT_ADMIN_TOKEN: "a" })).toBe("d");
    expect(readToken({ RESIDENT_ADMIN_TOKEN: "a" })).toBeNull();
    expect(readToken({ RESIDENT_OPERATOR_TOKEN: "o", RESIDENT_READ_TOKEN: "r" })).toBeNull();
    expect(readToken({ RESIDENT_ADMIN_TOKEN: "  " })).toBeNull();
    expect(readToken({})).toBeNull();
  });
});
