import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPagingObserver } from "./pagingDiagnostic.js";

const source = "a".repeat(40);
const app = "11111111-1111-4111-8111-111111111111";
const env = { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" };
const page = (next: unknown = null) => ({
  instances: [{ id: "private-instance", name: "private-name", state: "running", version: 12 }],
  result_info: { page_token: "private-cursor", next_page_token: next },
});
const event = { app, pageIndex: 2, requestedCursor: "private-cursor", cumulativeCount: 2 };

describe("bounded paging evidence", () => {
  it("consumer predicates stay structural, preserve interruption and cannot overwrite the first read", () => {
    const directory = mkdtempSync(join(tmpdir(), "consumer-predicates-"));
    const file = join(directory, "capture.json");
    const logs: string[] = [];
    const capture = createPagingObserver({
      log: (line) => logs.push(line),
      source,
      expectedCommit: source,
      env,
      artifactFile: file,
    });
    try {
      capture.observe({ ...event, phase: "failure", reason: "interrupted" });
      capture.recordConsumerReads({
        health: { status: 200, body: { secret: "private-body" } },
        application: { value: { version: 12, image: "private-image" } },
        instances: { error: "private-error" },
      });
      const text = readFileSync(file, "utf8");
      expect(JSON.parse(text)).toMatchObject({
        originalError: "interrupted",
        consumerReads: { health: "available", healthStatus: 200, application: "available", instances: "read-error" },
      });
      capture.recordConsumerReads({ health: { status: 503 }, application: null, instances: null });
      expect(readFileSync(file, "utf8")).toBe(text);
      expect(text + logs.join("\n")).not.toContain("private-");
    } finally {
      capture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("consumer predicates keep unknown input unknown and tolerate an unavailable sink", () => {
    const directory = mkdtempSync(join(tmpdir(), "consumer-unknown-"));
    const file = join(directory, "capture.json");
    const capture = createPagingObserver({
      log: () => {
        throw new Error("sink unavailable");
      },
      source,
      expectedCommit: source,
      env,
      artifactFile: file,
    });
    try {
      capture.recordConsumerReads({
        health: { status: "private-status" },
        application: { value: "private-value" },
        instances: { value: "private-value" },
      });
      expect(JSON.parse(readFileSync(file, "utf8")).consumerReads).toEqual({
        health: "unknown",
        healthStatus: null,
        application: "unknown",
        instances: "unknown",
      });
    } finally {
      capture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("preserves actual wire facts separately from argv and freezes the original failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "paging-evidence-"));
    const file = join(directory, "capture.json");
    const logs: string[] = [];
    const capture = createPagingObserver({
      log: (line) => logs.push(line),
      source,
      expectedCommit: source,
      env,
      artifactFile: file,
    });
    try {
      capture.observe({ ...event, phase: "before", producerVersion: "4.143.0" });
      capture.observe({
        ...event,
        phase: "after",
        page: page("private-cursor"),
        commandExit: 0,
        producerLog: `-- START CF API REQUEST: https://api.cloudflare.com/client/v4/accounts/private-account/containers/dash/applications/${app}/instances?per_page=100&page_token=private-cursor\nAuthorization: Bearer private-secret\n-- START CF API RESPONSE: OK 200\ncf-ray: 0123456789abcdef-SJC\nBODY: private-body`,
      });
      capture.observe({ ...event, phase: "failure", reason: "repeated-cursor" });
      const original = readFileSync(file, "utf8");
      capture.observe({ ...event, phase: "failure", reason: "malformed-page" });
      expect(readFileSync(file, "utf8")).toBe(original);
      const saved = JSON.parse(original);
      expect(saved.originalError).toBe("repeated-cursor");
      expect(saved.producerVersion).toBe("4.143.0");
      expect(saved.frames.map((f: { phase: string }) => f.phase)).toEqual(["before", "after", "failure"]);
      const response = saved.frames[1];
      expect(response.http.status).toBe(200);
      expect(response.http.requestId).toBe("0123456789abcdef-SJC");
      expect(response.http.request.cursorHash).toBe(response.requestedCursorHash);
      expect(response.nextCursorHash).toBe(response.requestedCursorHash);
      expect(response.pageCount).toBe(1);
      expect(response.cumulativeCount).toBe(2);
      expect(response.versionHistogram).toEqual({ "12": 1 });
      expect(response.http.request.path).toBe("/accounts/<account>/containers/dash/applications/<app>/instances");
      for (const forbidden of [
        "private-cursor",
        "private-account",
        app,
        "private-name",
        "private-instance",
        "private-secret",
        "private-body",
        directory,
      ])
        expect(original + logs.join("\n")).not.toContain(forbidden);
    } finally {
      capture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("retains the latest pending read and never invents unavailable HTTP facts", () => {
    const directory = mkdtempSync(join(tmpdir(), "paging-pending-"));
    const file = join(directory, "capture.json");
    const capture = createPagingObserver({ log: () => {}, source, expectedCommit: source, env, artifactFile: file });
    try {
      capture.observe({ ...event, phase: "after", page: page(), commandExit: 0 });
      expect(JSON.parse(readFileSync(file, "utf8")).frames[0].http).toEqual({ available: false });
      capture.observe({ ...event, pageIndex: 3, phase: "before" });
      expect(JSON.parse(readFileSync(file, "utf8")).frames.at(-1)).toMatchObject({ phase: "before", pageIndex: 3 });
      capture.observe({ ...event, pageIndex: 3, phase: "failure", reason: "interrupted" });
      expect(JSON.parse(readFileSync(file, "utf8")).originalError).toBe("interrupted");
    } finally {
      capture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("reserves a bounded final capture when long progress exhausts its budget and artifact IO fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "paging-failure-"));
    const file = join(directory, "foreign.json");
    writeFileSync(file, "foreign bytes");
    const logs: string[] = [];
    const capture = createPagingObserver({
      log: (line) => logs.push(line),
      source,
      expectedCommit: source,
      env,
      artifactFile: file,
    });
    try {
      for (let pageIndex = 1; pageIndex <= 100; pageIndex++) {
        capture.observe({ ...event, pageIndex, phase: "before" });
        capture.observe({
          ...event,
          pageIndex,
          phase: "after",
          page: page("x".repeat(20000) + "秘密"),
          producerLog: "private ".repeat(10000),
        });
      }
      capture.observe({ ...event, pageIndex: 100, phase: "failure", reason: "repeated-cursor" });
      const final = JSON.parse(logs.at(-1)!.replace("[paging-diagnostic] ", ""));
      expect(final.phase).toBe("capture");
      expect(final.originalError).toBe("repeated-cursor");
      expect(final.diagnosticWriteProblem).toBe("artifact-write-unavailable");
      expect(final.frames.slice(-3).map((f: { phase: string }) => f.phase)).toEqual(["before", "after", "failure"]);
      expect(Buffer.byteLength(logs.join(""))).toBeLessThanOrEqual(16384);
      expect(readFileSync(file, "utf8")).toBe("foreign bytes");
      capture.recordConsumerReads({
        health: { status: 503 },
        application: { error: "private-error" },
        instances: { error: "private-error" },
      });
      expect(JSON.parse(logs.at(-1)!.replace("[paging-diagnostic] ", ""))).toMatchObject({
        phase: "consumer-read",
        predicates: { health: "non-200", healthStatus: 503, application: "read-error", instances: "read-error" },
      });
      expect(Buffer.byteLength(logs.join("\n")) + 1).toBeLessThanOrEqual(16384);
    } finally {
      capture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("bounds large malformed Unicode metadata and distinguishes missing instances from empty inventory", () => {
    const directory = mkdtempSync(join(tmpdir(), "paging-cap-")),
      file = join(directory, "capture.json");
    const capture = createPagingObserver({ log: () => {}, source, expectedCommit: source, env, artifactFile: file });
    try {
      const large = {
        result_info: {
          ["秘密".repeat(10000)]: "private-customer-bytes",
          next_page_token: { secret: "private-secret" },
        },
      };
      capture.observe({ ...event, phase: "after", page: large });
      capture.observe({ ...event, phase: "failure", reason: "malformed-page" });
      const bytes = readFileSync(file, "utf8"),
        saved = JSON.parse(bytes);
      expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(16384);
      expect(saved.frames[0]).toMatchObject({
        pageCount: null,
        instancesType: "absent",
        metadataType: "object",
        unknownMetadataKeys: 1,
        end: "malformed",
      });
      expect(saved.frames[0].metadata.next_page_token).toBe("object");
      expect(bytes).not.toContain("秘密");
      expect(bytes).not.toContain("private-secret");
    } finally {
      capture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
