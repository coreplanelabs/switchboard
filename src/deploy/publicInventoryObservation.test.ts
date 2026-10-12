import { describe, expect, it } from "vitest";
import { observePublicInventory } from "./publicInventoryObservation.js";
import { createPagingObserver } from "./pagingDiagnostic.js";

const account = "a".repeat(32),
  application = "11111111-1111-4111-8111-111111111111";
const headers = { authorization: "Bearer synthetic-no-access" };
const row = {
  id: "b".repeat(64),
  application_id: application,
  name: "private-name",
  image: "registry.example/private-image",
  status: { state: "running", updated_at: "2026-01-01T00:00:00Z" },
  environment_variables: [{ name: "private-secret", value: "do-not-retain" }],
};
const page = (result: unknown[], next: unknown = null) => ({
  success: true,
  errors: [],
  result,
  result_info: { next_page_token: next },
});

describe("public inventory observation", () => {
  it("follows empty continuation, retains duplicate emitted rows and never exposes provider fields", async () => {
    const requests: string[] = [],
      logs: string[] = [];
    const observer = createPagingObserver({
      source: "c".repeat(40),
      expectedCommit: "c".repeat(40),
      env: {},
      log: (line) => logs.push(line),
    });
    const bodies = [page([], "opaque+/=&%"), page([row, row])];
    try {
      const actual = await observePublicInventory(
        account,
        application,
        headers,
        new AbortController().signal,
        observer.observe,
        async (url, options) => {
          expect(options?.method).toBe("GET");
          requests.push(String(url));
          return Response.json(bodies.shift());
        },
      );
      expect(actual).toEqual({
        complete: true,
        pages: 2,
        rows: 2,
        states: { running: 2 },
        missingNames: 0,
        emptyImages: 0,
        reason: "public metadata traversal complete; application-version evidence unavailable",
      });
      expect(requests.map((url) => new URL(url).searchParams.get("page_token"))).toEqual([null, "opaque+/=&%"]);
      expect(
        requests.every(
          (url) =>
            new URL(url).pathname ===
            `/client/v4/accounts/${account}/containers/applications/${application}/instances-v2`,
        ),
      ).toBe(true);
      expect(JSON.stringify(actual) + logs.join("\n")).not.toMatch(/private-|do-not-retain|opaque\+/);
      expect(logs.join("\n")).not.toContain(account);
      expect(logs.join("\n")).not.toContain(application);
      const frames = logs.map((line) => JSON.parse(line.replace("[paging-diagnostic] ", "")));
      expect(frames.filter((frame) => frame.phase === "before").map((frame) => frame.request)).toEqual([
        { started: true, method: "GET", queryEncoding: "URLSearchParams", perPage: 100, cursorParameter: "absent" },
        { started: true, method: "GET", queryEncoding: "URLSearchParams", perPage: 100, cursorParameter: "page_token" },
      ]);
      expect(
        frames
          .filter((frame) => frame.phase === "after")
          .map((frame) => ({
            next: frame.nextCursorProvenance,
            reported: frame.reportedCursorProvenance,
            end: frame.end,
          })),
      ).toEqual([
        { next: "public response result_info.next_page_token", reported: "unavailable", end: "continue" },
        { next: "public response result_info.next_page_token", reported: "unavailable", end: "null" },
      ]);
      expect(frames.map((frame) => "argv" in frame)).toEqual([false, false, false, false]);
    } finally {
      observer.close();
    }
  });

  it.each([201, 202, 206, 401, 403, 500])(
    "stops at HTTP %s without reading the private body or a fallback route",
    async (status) => {
      const requests: string[] = [];
      const actual = await observePublicInventory(
        account,
        application,
        headers,
        new AbortController().signal,
        undefined,
        async (url) => {
          requests.push(String(url));
          return new Response("private-token-and-error", { status });
        },
      );
      expect(actual).toEqual({
        complete: false,
        pages: 1,
        rows: 0,
        states: {},
        missingNames: 0,
        emptyImages: 0,
        reason: `public metadata ${status === 401 || status === 403 ? "denied" : "native-http-error"}; completeness unverified`,
        failure: {
          stage: "instances",
          reason: status === 401 || status === 403 ? "denied" : "native-http-error",
          commandExit: null,
          httpStatus: status,
          errorClass: "unknown",
          responseFormat: "unknown",
          providerCodes: [],
        },
      });
      expect(requests).toEqual([
        `https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications/${application}/instances-v2?per_page=100`,
      ]);
    },
  );

  it.each([
    {},
    { success: true, result: [] },
    page([{ ...row, application_id: "foreign-app" }]),
    page([{ ...row, status: { ...row.status, state: "private-state" } }]),
    page([], 42),
  ])("refuses missing or malformed scope and continuation metadata", async (body) => {
    const actual = await observePublicInventory(
      account,
      application,
      headers,
      new AbortController().signal,
      undefined,
      async () => Response.json(body),
    );
    expect(actual).toEqual({
      complete: false,
      pages: 1,
      rows: 0,
      states: {},
      missingNames: 0,
      emptyImages: 0,
      reason: "public metadata malformed-page; completeness unverified",
    });
  });

  it("retains numeric provider errors without returning their private messages", async () => {
    const actual = await observePublicInventory(
      account,
      application,
      headers,
      new AbortController().signal,
      undefined,
      async () => Response.json({ success: false, errors: [{ code: 10000, message: "private-token" }] }),
    );
    expect(actual).toMatchObject({
      complete: false,
      rows: 0,
      reason: "public metadata native-api-error; completeness unverified",
      failure: { httpStatus: 200, responseFormat: "json", providerCodes: [10000], errorClass: "unknown" },
    });
    expect(JSON.stringify(actual)).not.toContain("private-token");
  });

  it("keeps unknown state unverified rather than classifying it inactive", async () => {
    expect(
      await observePublicInventory(account, application, headers, new AbortController().signal, undefined, async () =>
        Response.json(page([{ ...row, status: { ...row.status, state: "unknown" } }])),
      ),
    ).toEqual({
      complete: false,
      pages: 1,
      rows: 1,
      states: { unknown: 1 },
      missingNames: 0,
      emptyImages: 0,
      reason: "public metadata unknown-state; completeness unverified",
    });
  });

  it("stops a continuation cycle and retains the original receipt in the bounded failure", async () => {
    const logs: string[] = [];
    let requests = 0;
    const observer = createPagingObserver({
      source: "c".repeat(40),
      expectedCommit: "c".repeat(40),
      env: {},
      log: (line) => logs.push(line),
    });
    try {
      const actual = await observePublicInventory(
        account,
        application,
        headers,
        new AbortController().signal,
        observer.observe,
        async () => {
          requests++;
          return Response.json(page([row], "private-next"));
        },
      );
      expect(actual).toMatchObject({
        complete: false,
        pages: 2,
        rows: 2,
        reason: "public metadata repeated-cursor; completeness unverified",
      });
      expect(requests).toBe(2);
      const capture = JSON.parse(logs.at(-1)!.replace("[paging-diagnostic] ", ""));
      expect(capture.frames.at(-1)).toMatchObject({
        reason: "repeated-cursor",
        cycleWitness: { firstSeen: { pageIndex: 1 }, repeated: { pageIndex: 2 } },
      });
      expect(logs.join("\n")).not.toContain("private-");
    } finally {
      observer.close();
    }
  });

  it("preserves cancellation after a positive response as incomplete", async () => {
    const controller = new AbortController();
    const actual = await observePublicInventory(
      account,
      application,
      headers,
      controller.signal,
      undefined,
      async () => {
        controller.abort();
        return Response.json(page([row]));
      },
    );
    expect(actual).toEqual({
      complete: false,
      pages: 1,
      rows: 0,
      states: {},
      missingNames: 0,
      emptyImages: 0,
      reason: "public metadata interrupted; completeness unverified",
    });
  });

  it("public cycle witnesses keep response provenance after their first frame leaves the ring", async () => {
    const logs: string[] = [];
    const observer = createPagingObserver({
      source: "c".repeat(40),
      expectedCommit: "c".repeat(40),
      env: {},
      log: (line) => logs.push(line),
    });
    let requests = 0;
    try {
      const actual = await observePublicInventory(
        account,
        application,
        headers,
        new AbortController().signal,
        observer.observe,
        async () => Response.json(page([], ++requests === 12 ? "private-next-1" : `private-next-${requests}`)),
      );
      expect(actual).toMatchObject({
        complete: false,
        pages: 12,
        rows: 0,
        reason: "public metadata repeated-cursor; completeness unverified",
      });
      const capture = JSON.parse(logs.at(-1)!.replace("[paging-diagnostic] ", ""));
      expect(capture).toMatchObject({
        producer: "cloudflare-public-v2",
        cursorEncoding: "direct GET query; URLSearchParams",
        originalError: "repeated-cursor",
      });
      expect(capture.frames.at(-1)).toMatchObject({
        request: { started: true, method: "GET", queryEncoding: "URLSearchParams", cursorParameter: "page_token" },
        http: { available: true, status: 200 },
        cycleWitness: {
          firstSeen: { pageIndex: 1 },
          repeated: { pageIndex: 12 },
          nextCursorProvenance: "public response result_info.next_page_token",
          cursorEncoding: "direct GET query; URLSearchParams",
        },
      });
      expect(JSON.stringify(capture)).not.toMatch(/CLI|argv|encodeURIComponent|private-/);
    } finally {
      observer.close();
    }
  });

  it.each([
    [undefined, "absent"],
    [null, "null"],
    ["", "empty"],
  ] as const)("public terminal %s retains the original continuation shape", async (next, end) => {
    const logs: string[] = [];
    const observer = createPagingObserver({
      source: "c".repeat(40),
      expectedCommit: "c".repeat(40),
      env: {},
      log: (line) => logs.push(line),
    });
    try {
      const actual = await observePublicInventory(
        account,
        application,
        headers,
        new AbortController().signal,
        observer.observe,
        async () => Response.json({ success: true, errors: [], result: [], result_info: { next_page_token: next } }),
      );
      expect(actual).toMatchObject({ complete: true, pages: 1, rows: 0 });
      expect(JSON.parse(logs.at(-1)!.replace("[paging-diagnostic] ", ""))).toMatchObject({
        phase: "after",
        end,
        nextCursorProvenance: "public response result_info.next_page_token",
        reportedCursorProvenance: "unavailable",
      });
    } finally {
      observer.close();
    }
  });

  it.each(["denied", "http", "api", "malformed", "unknown", "network", "interrupted"])(
    "public %s failures retain only the direct request facts actually observed",
    async (mode) => {
      const logs: string[] = [];
      const observer = createPagingObserver({
        source: "c".repeat(40),
        expectedCommit: "c".repeat(40),
        env: {},
        log: (line) => logs.push(line),
      });
      const control = new AbortController();
      try {
        const actual = await observePublicInventory(
          account,
          application,
          headers,
          control.signal,
          observer.observe,
          async () => {
            if (mode === "network") throw new Error("private-network");
            if (mode === "interrupted") {
              control.abort();
              throw new Error("private-abort");
            }
            if (mode === "denied" || mode === "http")
              return new Response("private-body", { status: mode === "denied" ? 403 : 500 });
            if (mode === "api") return Response.json({ success: false, errors: [{ code: 10000 }] });
            if (mode === "malformed") return new Response("private-invalid-json");
            return Response.json(page([{ ...row, status: { ...row.status, state: "unknown" } }]));
          },
        );
        expect(actual.complete).toBe(false);
        const capture = JSON.parse(logs.at(-1)!.replace("[paging-diagnostic] ", ""));
        expect(capture).toMatchObject({
          producer: "cloudflare-public-v2",
          cursorEncoding: "direct GET query; URLSearchParams",
        });
        expect(capture.frames.at(-1)).toMatchObject({
          request: { started: true, method: "GET", queryEncoding: "URLSearchParams", cursorParameter: "absent" },
          http:
            mode === "network" || mode === "interrupted"
              ? { available: false }
              : { available: true, status: mode === "denied" ? 403 : mode === "http" ? 500 : 200 },
        });
        expect(JSON.stringify(capture)).not.toMatch(/CLI|argv|encodeURIComponent|private-/);
      } finally {
        observer.close();
      }
    },
  );

  it.each(["scope", "credentials", "already-aborted"])(
    "public %s refusal claims no request or CLI transformation",
    async (mode) => {
      const logs: string[] = [];
      const observer = createPagingObserver({
        source: "c".repeat(40),
        expectedCommit: "c".repeat(40),
        env: {},
        log: (line) => logs.push(line),
      });
      const control = new AbortController();
      if (mode === "already-aborted") control.abort();
      try {
        const actual = await observePublicInventory(
          mode === "scope" ? "invalid" : account,
          application,
          mode === "credentials" ? undefined : headers,
          control.signal,
          observer.observe,
          async () => {
            throw new Error("unexpected request");
          },
        );
        expect(actual).toMatchObject({ complete: false, pages: 0, rows: 0 });
        const capture = JSON.parse(logs.at(-1)!.replace("[paging-diagnostic] ", ""));
        expect(capture).toMatchObject({
          producer: "cloudflare-public-v2",
          cursorEncoding: "unavailable; request not started",
          frames: [{ phase: "failure", request: { started: false } }],
        });
        expect(JSON.stringify(capture)).not.toMatch(/CLI|argv|encodeURIComponent|URLSearchParams|"http"/);
      } finally {
        observer.close();
      }
    },
  );
});
