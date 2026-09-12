import { describe, expect, it } from "vitest";
import {
  COORDINATOR_AUTHORIZE_PATH,
  COORDINATOR_INSTANCE_STATUS_PREFIX,
  COORDINATOR_INSTANCES_PATH,
  instanceStatusResponse,
  isInstanceNotFound,
  parseInstanceStatusPath,
  readInstanceStatusAnswer,
  createInstanceResponse,
  parseCreateInstanceRequest,
  parseSubjectAuthorization,
  readCreateInstanceAnswer,
} from "./instancesRoute.js";

// Feature: docs/reference/specs/http-ingress.md item 9 — the pure halves of
// the shim's `POST /admin/coordinator/instances`: the body it accepts, how it
// reads the bot's authorization answer, and the wire shape of each outcome.
// The Workflow `create` itself is the shim's one line; everything decidable
// without the platform is decided here and tested in plain Node.

describe("the shim's instance route — the paths", () => {
  it("names the route and the bot's authorize question", () => {
    expect(COORDINATOR_INSTANCES_PATH).toBe("/admin/coordinator/instances");
    expect(COORDINATOR_AUTHORIZE_PATH).toBe("/admin/coordinator/authorize");
  });
});

describe("parseCreateInstanceRequest — the body", () => {
  it("accepts an instance id in the platform's alphabet with a params object, defaulting params to {}", () => {
    expect(parseCreateInstanceRequest(JSON.stringify({ id: "ship_acme_api_1", params: { plan: "p" } }))).toEqual({
      ok: true,
      id: "ship_acme_api_1",
      params: { plan: "p" },
    });
    expect(parseCreateInstanceRequest(JSON.stringify({ id: "ship_acme_api_1" }))).toEqual({
      ok: true,
      id: "ship_acme_api_1",
      params: {},
    });
  });

  it("refuses non-JSON, a non-object, a missing or malformed id, and non-object params — by name", () => {
    expect(parseCreateInstanceRequest("nope")).toEqual({ ok: false, reason: "body is not valid JSON" });
    expect(parseCreateInstanceRequest("[]")).toEqual({ ok: false, reason: "body must be a JSON object" });
    expect(parseCreateInstanceRequest("{}")).toMatchObject({ ok: false, reason: expect.stringContaining("id") });
    expect(parseCreateInstanceRequest(JSON.stringify({ id: "has:colon" }))).toMatchObject({ ok: false });
    expect(parseCreateInstanceRequest(JSON.stringify({ id: "a".repeat(101) }))).toMatchObject({ ok: false });
    expect(parseCreateInstanceRequest(JSON.stringify({ id: "ok_1", params: [] }))).toEqual({
      ok: false,
      reason: "`params` must be an object",
    });
  });
});

describe("parseSubjectAuthorization — the bot's answer as the shim reads it", () => {
  it("200 with a subject is allowed; 401/403/503 with an error are relayed; anything else is 503, fail-closed", () => {
    expect(parseSubjectAuthorization(200, JSON.stringify({ ok: true, subject: "coordinator" }))).toEqual({
      ok: true,
      subject: "coordinator",
    });
    expect(parseSubjectAuthorization(403, JSON.stringify({ ok: false, error: "forbidden: no grant" }))).toEqual({
      ok: false,
      status: 403,
      reason: "forbidden: no grant",
    });
    expect(parseSubjectAuthorization(401, JSON.stringify({ ok: false, error: "unauthorized" }))).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(parseSubjectAuthorization(503, JSON.stringify({ ok: false, error: "disabled" }))).toMatchObject({
      ok: false,
      status: 503,
    });
    expect(parseSubjectAuthorization(200, JSON.stringify({ ok: true }))).toMatchObject({ ok: false, status: 503 });
    expect(parseSubjectAuthorization(404, "not found")).toMatchObject({
      ok: false,
      status: 503,
      reason: expect.stringContaining("HTTP 404"),
    });
    expect(parseSubjectAuthorization(500, "<html>")).toMatchObject({ ok: false, status: 503 });
  });
});

describe("createInstanceResponse — the wire shape of each outcome", () => {
  it("created is 201 with the id; a duplicate id is 409 with the existing instance's status; a failure is 502 with the reason", () => {
    expect(createInstanceResponse({ kind: "created", id: "ship_1" })).toEqual({
      status: 201,
      body: { ok: true, id: "ship_1", created: true },
    });
    expect(createInstanceResponse({ kind: "duplicate", id: "ship_1", status: "running" })).toEqual({
      status: 409,
      body: { ok: false, error: "duplicate_instance", id: "ship_1", status: "running" },
    });
    expect(createInstanceResponse({ kind: "failed", id: "ship_1", reason: "boom" })).toEqual({
      status: 502,
      body: { ok: false, error: "create_failed", id: "ship_1", message: "boom" },
    });
  });
});

describe("readCreateInstanceAnswer — the shim's answer as the bot reads it", () => {
  it("201 created, 409 duplicate with the existing instance's status, 502 failed with the reason; anything else — the door's 401/403, non-JSON, a shim without the route — is unanswered by reason", () => {
    expect(readCreateInstanceAnswer(201, JSON.stringify({ ok: true, id: "plan-x", created: true }))).toEqual({
      kind: "created",
      id: "plan-x",
    });
    expect(
      readCreateInstanceAnswer(
        409,
        JSON.stringify({ ok: false, error: "duplicate_instance", id: "plan-x", status: "complete" }),
      ),
    ).toEqual({ kind: "duplicate", id: "plan-x", status: "complete" });
    expect(
      readCreateInstanceAnswer(409, JSON.stringify({ ok: false, error: "duplicate_instance", id: "plan-x" })),
    ).toEqual({
      kind: "duplicate",
      id: "plan-x",
    });
    expect(
      readCreateInstanceAnswer(
        502,
        JSON.stringify({ ok: false, error: "create_failed", id: "plan-x", message: "engine down" }),
      ),
    ).toEqual({ kind: "failed", id: "plan-x", reason: "engine down" });
    expect(readCreateInstanceAnswer(403, JSON.stringify({ ok: false, error: "forbidden: no grant" }))).toEqual({
      kind: "unanswered",
      reason: "HTTP 403 — forbidden: no grant",
    });
    expect(readCreateInstanceAnswer(404, "not found")).toEqual({ kind: "unanswered", reason: "HTTP 404 — not found" });
    expect(readCreateInstanceAnswer(201, "<html>")).toEqual({ kind: "unanswered", reason: "HTTP 201 — <html>" });
  });
});

describe("the instance status route — the pure halves both ways", () => {
  it("names the path, reads the id out of it and nothing else", () => {
    expect(COORDINATOR_INSTANCE_STATUS_PREFIX).toBe("/admin/coordinator/instances/");
    expect(parseInstanceStatusPath("/admin/coordinator/instances/plan-fixture")).toBe("plan-fixture");
    expect(parseInstanceStatusPath("/admin/coordinator/instances/plan-fixture-2")).toBe("plan-fixture-2");
    expect(parseInstanceStatusPath("/admin/coordinator/instances/")).toBeUndefined();
    expect(parseInstanceStatusPath("/admin/coordinator/instances/has:colon")).toBeUndefined();
    expect(parseInstanceStatusPath("/admin/coordinator/instances")).toBeUndefined();
    expect(parseInstanceStatusPath("/admin/coordinator/spawn")).toBeUndefined();
  });

  it("absence is the engine's own word only — the `instance.not_found` code; a failure whose text merely says not found, does not exist or no such is a failure", () => {
    expect(isInstanceNotFound("instance.not_found")).toBe(true);
    expect(isInstanceNotFound("Error: instance.not_found: no instance plan-fixture")).toBe(true);
    expect(isInstanceNotFound("INSTANCE.NOT_FOUND")).toBe(true);
    expect(isInstanceNotFound("binding SHIP_COORDINATOR not found")).toBe(false);
    expect(isInstanceNotFound("the script does not exist")).toBe(false);
    expect(isInstanceNotFound("no such workflow")).toBe(false);
    expect(isInstanceNotFound("instance_not_found")).toBe(false);
    expect(isInstanceNotFound("")).toBe(false);
  });

  it("the shim answers the platform's status word as 200, no such instance as 404 no_instance, the engine failing as 502 by reason", () => {
    expect(instanceStatusResponse({ kind: "status", id: "plan-x", status: "running" })).toEqual({
      status: 200,
      body: { ok: true, id: "plan-x", status: "running" },
    });
    expect(instanceStatusResponse({ kind: "absent", id: "plan-x" })).toEqual({
      status: 404,
      body: { ok: false, error: "no_instance", id: "plan-x" },
    });
    expect(instanceStatusResponse({ kind: "failed", id: "plan-x", reason: "engine down" })).toEqual({
      status: 502,
      body: { ok: false, error: "status_failed", id: "plan-x", message: "engine down" },
    });
  });

  it("the bot reads the status word, the absence, and anything else — the door's refusal, a shim without the route — as unanswered by reason", () => {
    expect(readInstanceStatusAnswer(200, JSON.stringify({ ok: true, id: "plan-x", status: "complete" }))).toEqual({
      kind: "status",
      status: "complete",
    });
    expect(readInstanceStatusAnswer(404, JSON.stringify({ ok: false, error: "no_instance", id: "plan-x" }))).toEqual({
      kind: "absent",
    });
    expect(readInstanceStatusAnswer(502, JSON.stringify({ ok: false, error: "status_failed", message: "x" }))).toEqual({
      kind: "unanswered",
      reason: "HTTP 502 — status_failed",
    });
    expect(readInstanceStatusAnswer(403, JSON.stringify({ ok: false, error: "forbidden" }))).toEqual({
      kind: "unanswered",
      reason: "HTTP 403 — forbidden",
    });
    expect(readInstanceStatusAnswer(404, "not found")).toEqual({ kind: "unanswered", reason: "HTTP 404 — not found" });
    expect(readInstanceStatusAnswer(200, JSON.stringify({ ok: true, id: "plan-x", status: "" }))).toMatchObject({
      kind: "unanswered",
    });
  });
});
