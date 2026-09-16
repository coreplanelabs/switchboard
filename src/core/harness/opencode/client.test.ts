import { ConfigGroup } from "@opencode/protocol/groups/config";
import { EventGroup } from "@opencode/protocol/groups/event";
import { HealthGroup } from "@opencode/protocol/groups/health";
import { MessageGroup } from "@opencode/protocol/groups/message";
import { makePermissionGroup } from "@opencode/protocol/groups/permission";
import { PluginGroup } from "@opencode/protocol/groups/plugin";
import { makeSessionGroup } from "@opencode/protocol/groups/session";
import { Permission } from "@opencode/schema/permission";
import { Schema } from "effect";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OPENCODE_REFILL_EVENTS,
  OPENCODE_ROUTES,
  OPENCODE_VERSION,
  openCodeAuthHeader,
  openCodePermissionReplyRoute,
  openCodeSessionRoutes,
  parseConfigEntries,
  parseFeedRecord,
  parseHealth,
  type OpenCodeHealth,
  type OpenCodeInboxUser,
  type OpenCodeMessage,
  type OpenCodePermissionRequest,
  type OpenCodeRoute,
} from "./client.js";

// Feature: docs/reference/specs/harness.md, the OpenCode process item — the
// client is derived from the pinned protocol, not from prose: every route this
// harness calls is read back from `@opencode/protocol@2.0.3`'s own endpoint
// definitions, built here exactly as the server builds them, and the shapes
// the harness reads are decoded by the pinned schemas from samples a live
// `serve` at the pin answered. A bump of the pin that moves a route or a field
// fails here, not in a run.

// The session and permission groups take the server's location middleware;
// any middleware service stands in for it — the paths do not depend on it.
// (The published package's `makeSessionGroup` takes the session middleware
// alone, where the tag's source takes two: the package is the pin.)
class Location extends HttpApiMiddleware.Service<Location>()("test/Location") {}
class SessionLocation extends HttpApiMiddleware.Service<SessionLocation>()("test/SessionLocation") {}
const session = makeSessionGroup(SessionLocation);
const permission = makePermissionGroup(Location, SessionLocation);

/** An endpoint as the pinned package holds it: the success schemas as a set
 *  (one per status), the payload schemas by content type. */
interface PinnedEndpoint {
  method: string;
  path: string;
  success: Set<Schema.Top>;
  payload?: Map<string, { schemas: Set<Schema.Top> }>;
}
const pinned = (group: { endpoints: Record<string, unknown> }, name: string): PinnedEndpoint => {
  const endpoint = group.endpoints[name] as PinnedEndpoint | undefined;
  if (!endpoint) throw new Error(`the pinned protocol has no endpoint ${name}`);
  return endpoint;
};
const successOf = (endpoint: PinnedEndpoint): Schema.Top | undefined => [...endpoint.success][0];
const payloadOf = (endpoint: PinnedEndpoint): Schema.Top | undefined => {
  const json = endpoint.payload?.get("application/json");
  return json ? [...json.schemas][0] : undefined;
};

/** A route with a session id put back to the protocol's template. */
const template = (route: OpenCodeRoute, ids: Record<string, string>): OpenCodeRoute => ({
  method: route.method,
  path: Object.entries(ids).reduce((p, [name, id]) => p.replace(`/${id}`, `/:${name}`), route.path),
});

const decodes = (schema: Schema.Top | undefined, value: unknown): string | undefined => {
  if (!schema) return "no schema";
  const result = Schema.decodeUnknownResult(schema as Schema.Codec<unknown, unknown>, { errors: "all" })(value);
  return result._tag === "Success" ? undefined : String(result.failure);
};

describe("the routes are the pinned protocol's", () => {
  it.each([
    ["health.get", HealthGroup],
    ["config.get", ConfigGroup],
    ["plugin.awaitActivation", PluginGroup],
    ["event.subscribe", EventGroup],
    ["session.create", session],
    ["session.import", session],
  ] as const)("%s", (name, group) => {
    const ours = OPENCODE_ROUTES[name];
    const theirs = pinned(group, name);
    expect({ method: ours.method, path: ours.path }).toEqual({ method: theirs.method, path: theirs.path });
  });

  it.each([
    ["session.prompt", session],
    ["session.wait", session],
    ["session.interrupt", session],
    ["session.messages", MessageGroup],
    ["session.permission.list", permission],
  ] as const)("%s, under a session", (name, group) => {
    const ours = openCodeSessionRoutes("ses_1")[name];
    const theirs = pinned(group, name);
    expect(template(ours, { sessionID: "ses_1" })).toEqual({ method: theirs.method, path: theirs.path });
  });

  it("the permission reply, under a session and a request", () => {
    const ours = openCodePermissionReplyRoute("ses_1", "per_1");
    const theirs = pinned(permission, "session.permission.reply");
    expect(template(ours, { sessionID: "ses_1", requestID: "per_1" })).toEqual({
      method: theirs.method,
      path: theirs.path,
    });
  });

  it("the version the client drives is the pin the protocol package was installed at", async () => {
    const manifest = new URL("../../../../node_modules/@opencode/protocol/package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
    expect(pkg.version).toBe(OPENCODE_VERSION);
  });
});

describe("the shapes are the pinned schemas', from what a live server answered", () => {
  it("the health answer, as the readiness probe reads it", () => {
    const sample: OpenCodeHealth = { healthy: true, version: "2.0.3", pid: 43067 };
    expect(decodes(successOf(pinned(HealthGroup, "health.get")), sample)).toBeUndefined();
    expect(parseHealth(JSON.stringify(sample))).toEqual(sample);
    expect(parseHealth(JSON.stringify({ healthy: true, version: "2.0.3" }))).toEqual({
      healthy: true,
      version: "2.0.3",
      pid: 0,
    });
    for (const bad of [
      "<html>",
      "{}",
      JSON.stringify({ healthy: false, version: "2.0.3" }),
      JSON.stringify({ healthy: true }),
    ])
      expect(parseHealth(bad)).toBeUndefined();
  });

  it("the ask, as the gate will read it: the action, the resources, and the source naming the tool call", () => {
    const sample: OpenCodePermissionRequest = {
      id: "per_0ab31d0e7001k0txM5YY4oSe83",
      sessionID: "ses_f54ce2f60fferPNusHOuMp25dU",
      action: "shell",
      resources: ["echo hi-from-shell"],
      save: ["echo *"],
      source: { type: "tool", messageID: "msg_0ab31d0c70010tP7OdxHn0njnH", id: "call_0" },
    };
    expect(decodes(successOf(pinned(permission, "session.permission.list")), { data: [sample] })).toBeUndefined();
    // The reply: `once` and `reject` are what the harness sends; `always` exists at the pin and is never sent by policy.
    const reply = payloadOf(pinned(permission, "session.permission.reply"));
    expect(decodes(reply, { reply: "once" })).toBeUndefined();
    expect(
      decodes(reply, { reply: "reject", message: "the rules refuse a push to the protected branch" }),
    ).toBeUndefined();
    expect(decodes(reply, { reply: "always" })).toBeUndefined();
    expect(decodes(reply, { reply: "maybe" })).toBeDefined();
    expect(Schema.decodeUnknownResult(Permission.Reply)("always")._tag).toBe("Success");
  });

  it("the prompt and its answer, the admitted inbox item", () => {
    const prompt = payloadOf(pinned(session, "session.prompt"));
    expect(decodes(prompt, { text: "please run the shell", delivery: "queue" })).toBeUndefined();
    expect(decodes(prompt, { text: "wrap up now", delivery: "steer" })).toBeUndefined();
    expect(decodes(prompt, { text: "x", delivery: "later" })).toBeDefined();
    const answer: OpenCodeInboxUser = {
      id: "msg_0ab31d0ab001rcwXPFuI3njUaD",
      sessionID: "ses_f54ce2f60fferPNusHOuMp25dU",
      timeCreated: 1789578563757,
      type: "user",
      payload: { text: "please run the shell" },
      delivery: "queue",
    };
    expect(decodes(successOf(pinned(session, "session.prompt")), { data: answer })).toBeUndefined();
  });

  it("the session create payload, with the location and the ask-on-all rule", () => {
    const create = payloadOf(pinned(session, "session.create"));
    expect(
      decodes(create, {
        location: { directory: "/tmp/switchboard-oc-run-7/home" },
        permissions: [{ action: "*", resource: "*", effect: "ask" }],
      }),
    ).toBeUndefined();
    expect(decodes(create, { permissions: [{ action: "*", resource: "*", effect: "maybe" }] })).toBeDefined();
  });

  it("the messages page, as the tailer refills it: user, assistant with its agent and content, idle", () => {
    const page: { data: OpenCodeMessage[]; cursor: Record<string, string> } = {
      data: [
        {
          id: "msg_0ab31d0ab001rcwXPFuI3njUaD",
          type: "user",
          text: "please run the shell",
          time: { created: 1789578563775 },
        },
        {
          id: "msg_0ab31d0c70010tP7OdxHn0njnH",
          type: "assistant",
          agent: "switchboard",
          model: { providerID: "switchboard", id: "test-model-1" },
          time: { created: 1789578563794, streamed: 1789578563801, completed: 1789578564254 },
          content: [
            {
              type: "tool",
              id: "call_0",
              tool: "shell",
              state: {
                status: "completed",
                input: { command: "echo hi-from-shell" },
                content: [{ type: "text", text: "hi-from-shell\n" }],
                time: { start: 1, end: 2 },
              },
            },
          ],
        },
        { id: "msg_0ab31d2b7002LnGHKvTTei9zFi", type: "idle", outcome: "succeeded", time: { created: 1789578564279 } },
      ],
      cursor: {},
    };
    const problem = decodes(successOf(pinned(MessageGroup, "session.messages")), page);
    // The tool content's inner state is the schema's to shape; what the harness reads — id, type, time, agent — is decoded here.
    if (problem) expect(problem).not.toMatch(/\["data", \d+, "(id|type|time|agent)"\]/);
    expect(
      decodes(successOf(pinned(MessageGroup, "session.messages")), { data: [page.data[0], page.data[2]], cursor: {} }),
    ).toBeUndefined();
  });

  it("the refill events are event types the pinned stream declares", async () => {
    const { EventManifest } = (await import("@opencode/schema/event-manifest")) as {
      EventManifest: { isServer: (e: { type: string }) => boolean };
    };
    for (const type of OPENCODE_REFILL_EVENTS) expect(EventManifest.isServer({ type }), type).toBe(true);
  });
});

describe("the parsers", () => {
  it("openCodeAuthHeader is Basic with the fixed user", () => {
    expect(openCodeAuthHeader("pw")).toBe(`Basic ${Buffer.from("opencode:pw").toString("base64")}`);
  });

  it("parseConfigEntries reads the entry list a live server answered and refuses anything else", () => {
    const body = JSON.stringify([
      { type: "directory", path: "/tmp/switchboard-oc-run-7/xdg/config/opencode" },
      { type: "document", path: "/tmp/switchboard-oc-run-7/opencode.json", info: { update: "disable", lsp: false } },
    ]);
    expect(parseConfigEntries(body)).toEqual([
      { type: "directory", path: "/tmp/switchboard-oc-run-7/xdg/config/opencode" },
      { type: "document", path: "/tmp/switchboard-oc-run-7/opencode.json", info: { update: "disable", lsp: false } },
    ]);
    for (const bad of [
      "nope",
      "{}",
      JSON.stringify([{ type: "document" }]),
      JSON.stringify([{ type: "other", path: "/x" }]),
      JSON.stringify([1]),
    ])
      expect(parseConfigEntries(bad)).toBeUndefined();
  });

  it("parseFeedRecord reads the four record kinds and nothing else", () => {
    expect(
      parseFeedRecord(
        JSON.stringify({ feed: "event", at: 1, event: { id: "evt_1", type: "server.connected", data: {} } }),
      ),
    ).toMatchObject({ feed: "event" });
    expect(
      parseFeedRecord(
        JSON.stringify({ feed: "permissions", at: 1, sessionID: "ses_1", reason: "session.step.ended", data: [] }),
      ),
    ).toMatchObject({ feed: "permissions" });
    expect(
      parseFeedRecord(JSON.stringify({ feed: "messages", at: 1, sessionID: "ses_1", reason: "reconnect", data: [] })),
    ).toMatchObject({ feed: "messages" });
    expect(parseFeedRecord(JSON.stringify({ feed: "tailer", at: 1, note: "started" }))).toMatchObject({
      feed: "tailer",
      note: "started",
    });
    for (const bad of [
      "not json",
      JSON.stringify({ type: "message_update" }),
      JSON.stringify({ feed: "other" }),
      "null",
    ])
      expect(parseFeedRecord(bad)).toBeUndefined();
  });
});
