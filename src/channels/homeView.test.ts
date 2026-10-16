import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { actor } from "../core/authz/testing.js";
import { createHomeService } from "../core/home/service.js";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import { makePageSender } from "./webShell.js";
import { createHomeViewHandler } from "./homeView.js";
import { resolveWorkViewScope, withWorkViewScope } from "./workViewScope.js";

const viewer = actor("user", "access:alice", { actions: "all", channels: "all", repos: "all" });
function response() {
  let status = 0,
    body = "",
    complete: () => void;
  const ended = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    ended,
    value: () => ({ status, body }),
    res: {
      setHeader() {},
      writeHead(value: number) {
        status = value;
      },
      end(value: string) {
        body = value;
        complete();
      },
    } as unknown as ServerResponse,
  };
}
function handler() {
  const service = createHomeService({
    organizationId: "installation-a",
    instances: { listInstances: async () => ({ items: [] }), listUnits: async () => [] },
  });
  return createHomeViewHandler(
    service,
    makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
    "installation-a",
  );
}
const request = (url: string, method = "GET") =>
  ({ url, method, headers: { accept: "application/json" } }) as IncomingMessage;

describe("authorized Home pages", () => {
  it("includes server-proved own answers in All people while Person cannot acquire an answer", async () => {
    const service = createHomeService({
      organizationId: "installation-a",
      instances: { listInstances: async () => ({ items: [] }), listUnits: async () => [] },
    });
    const read = createHomeViewHandler(
      service,
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
      {
        answers: async () => ({
          "own:answer": { thread: "worker:own:answer", revision: 1, question: "Own recorded question" },
        }),
      },
    );
    const actual = actor(
      "user",
      "access:alice",
      {},
      { grants: { actions: "all", channels: "all", repos: "all", organizations: "all" } },
    );
    withWorkViewScope(actual, resolveWorkViewScope(actual, { organization: "installation-a", mode: "everyone" }));
    expect(resolveWorkViewScope(actual, { organization: "installation-a", mode: "everyone" }).mode).toBe("everyone");
    const all = response();
    read(request("/home"), all.res, { actor: actual, organization: "installation-a" });
    await all.ended;
    expect(JSON.parse(all.value().body)).toMatchObject({
      page: "fleetHome",
      answers: { "own:answer": { thread: "worker:own:answer", revision: 1, question: "Own recorded question" } },
    });
    const person = { ...actual, viewingAs: { id: "access:bob" } };
    withWorkViewScope(person, resolveWorkViewScope(person, { organization: "installation-a" }));
    const viewed = response();
    read(request("/home"), viewed.res, { actor: person, organization: "installation-a" });
    await viewed.ended;
    expect(JSON.parse(viewed.value().body).answers).toBeUndefined();
  });
  it("opens an authorized private unit thread without seeding private input and fences permission loss before emission", async () => {
    const service = createHomeService({
      organizationId: "installation-a",
      instances: { listInstances: async () => ({ items: [] }), listUnits: async () => [] },
    });
    let readable = true,
      revoke = false;
    const read = createHomeViewHandler(
      service,
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
      {
        privateEpoch: async () => (readable ? "current-source" : undefined),
        thread: async (_context, key) => {
          if (!readable || key !== "worker:private-work:question") return;
          if (revoke) readable = false;
          return {
            label: "Owned unit",
            revision: 1,
            canWrite: true,
            entries: [{ id: "worker:1", role: "assistant", content: "Private recorded reply", isViewer: false }],
            history: { cursor: 1, hasMore: false, status: "partial" },
          };
        },
      },
    );
    const allowed = response();
    expect(
      read(request("/threads/worker%3Aprivate-work%3Aquestion"), allowed.res, {
        actor: viewer,
        organization: "installation-a",
      }),
    ).toBe(true);
    await allowed.ended;
    expect(allowed.value().status).toBe(200);
    expect(JSON.parse(allowed.value().body)).toMatchObject({
      page: "home",
      conversation: "worker:private-work:question",
      turns: [],
      conversations: [],
      suggestions: [],
      sendUrl: "",
    });
    expect(allowed.value().body).not.toContain("Private recorded reply");
    const unknown = response();
    read(request("/threads/worker%3Aforeign%3Aquestion"), unknown.res, {
      actor: viewer,
      organization: "installation-a",
    });
    await unknown.ended;
    expect(unknown.value()).toEqual({ status: 404, body: "not found" });
    revoke = true;
    const denied = response();
    read(request("/threads/worker%3Aprivate-work%3Aquestion"), denied.res, {
      actor: viewer,
      organization: "installation-a",
    });
    await denied.ended;
    expect(denied.value()).toEqual({ status: 404, body: "not found" });
  });
  it("fences private Home text when source permission changes during answer enrichment", async () => {
    const service = createHomeService({
      organizationId: "installation-a",
      instances: {
        listInstances: async () => ({
          items: [
            {
              id: "private-work",
              kind: "ship",
              userId: "access:alice",
              channelId: "web:alice",
              threadKey: "web:alice:organization",
              repo: "example/app",
              branch: "work",
              createdAt: 1,
            },
          ],
        }),
        listUnits: async () => [
          {
            instanceId: "private-work",
            unit: "question",
            slug: "question",
            title: "Private source question",
            branch: "work/question",
            dependsOn: [],
            rounds: [],
            workBrief: {} as import("../core/coordinator/contract.js").CoordinatorUnit["workBrief"],
          },
        ],
      },
    });
    let readable = true,
      revoke = false;
    const read = createHomeViewHandler(
      service,
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
      {
        privateUnit: async () => readable,
        privateEpoch: async () => "unchanged-host-epoch",
        answers: async () => {
          if (revoke) readable = false;
          return {};
        },
      },
    );
    const allowed = response();
    read(request("/home"), allowed.res, { actor: viewer, organization: "installation-a" });
    await allowed.ended;
    expect(allowed.value().status).toBe(200);
    expect(allowed.value().body).toContain("Private source question");
    revoke = true;
    const denied = response();
    read(request("/home"), denied.res, { actor: viewer, organization: "installation-a" });
    await denied.ended;
    expect(denied.value()).toEqual({ status: 404, body: "not found" });
  });
  it("uses the proved person for attention while retaining the credential's read authority", async () => {
    const service = createHomeService({
      organizationId: "installation-a",
      instances: {
        listInstances: async () => ({
          items: [
            {
              id: "own-work",
              kind: "ship",
              userId: "access:alice",
              channelId: "slack:private",
              threadKey: "slack:private:1",
              repo: "example/app",
              branch: "work",
              createdAt: 1,
            },
            {
              id: "hidden-work",
              kind: "ship",
              userId: "person:alice",
              channelId: "slack:private",
              threadKey: "slack:private:2",
              repo: "example/app",
              branch: "work",
              createdAt: 2,
            },
          ],
        }),
        listUnits: async (instanceId) => [
          { instanceId, unit: "question", slug: "question", branch: "work/question", dependsOn: [], rounds: [] },
        ],
      },
      conditions: {
        list: async (unitKey) => [
          {
            id: `ask:${unitKey}`,
            unitKey,
            revision: 1,
            state: "open",
            owner: { kind: "person", id: "person:alice" },
            summary: "Confirm the target",
            nextAction: "Choose staging",
          },
        ],
      },
    });
    const admitted = actor("user", "access:alice", { actions: new Set(["runs:read"]) });
    const read = createHomeViewHandler(
      service,
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
    );
    const output = response();
    read(request("/home/snapshot?actor=person:alice&attentionRecipient=person:foreign"), output.res, {
      actor: admitted,
      organization: "installation-a",
      attentionRecipient: "person:alice",
    });
    await output.ended;
    const snapshot = JSON.parse(output.value().body);
    expect(snapshot.attentionRecipient).toBe("person:alice");
    expect(snapshot.needsYou.map((row: { unit: { unit: string } }) => row.unit.unit)).toEqual(["own-work:question"]);
    expect(JSON.stringify(snapshot)).not.toContain("hidden-work");
    const forged = response();
    read(request("/home/snapshot?attentionRecipient=person:alice"), forged.res, {
      actor: admitted,
      organization: "installation-a",
    });
    await forged.ended;
    expect(JSON.parse(forged.value().body)).toMatchObject({ attentionRecipient: "access:alice", needsYou: [] });
  });
  it("ignores client actor and organization claims and paints the admitted organization", async () => {
    const output = response();
    expect(
      handler()(request("/home?organization=foreign&actor=bob"), output.res, {
        actor: viewer,
        organization: "installation-a",
      }),
    ).toBe(true);
    await output.ended;
    expect(output.value().status).toBe(200);
    expect(JSON.parse(output.value().body)).toMatchObject({
      page: "fleetHome",
      attentionRecipient: "access:alice",
      snapshot: { organizationId: "installation-a", status: "complete", needsYou: [], moving: [], waiting: [] },
    });
  });
  it("refuses absent and foreign tenant admission before building a page", async () => {
    for (const context of [{}, { actor: viewer, organization: "foreign" }]) {
      const output = response();
      handler()(request("/home"), output.res, context);
      await output.ended;
      expect(output.value()).toEqual({ status: 404, body: "not found" });
    }
  });
  it("keeps an unknown pipeline non-revealing and exposes a separate completed history page", async () => {
    const unknown = response();
    handler()(request("/pipelines/missing"), unknown.res, { actor: viewer, organization: "installation-a" });
    await unknown.ended;
    expect(unknown.value()).toEqual({ status: 404, body: "not found" });
    const history = response();
    handler()(request("/home/history"), history.res, { actor: viewer, organization: "installation-a" });
    await history.ended;
    expect(JSON.parse(history.value().body)).toMatchObject({
      page: "fleetHistory",
      history: { organizationId: "installation-a", status: "complete", units: [] },
    });
  });
  it("keeps completed pipeline links readable and preserves proven moving activity", async () => {
    const completed = {
      id: "completed",
      kind: "ship" as const,
      userId: "access:alice",
      channelId: "slack:C1",
      threadKey: "slack:C1:1",
      repo: "example/app",
      branch: "work",
      createdAt: 1,
    };
    const moving = { ...completed, id: "moving" };
    const home = createHomeService({
      organizationId: "installation-a",
      instances: {
        get: async (id) => (id === completed.id ? completed : id === moving.id ? moving : null),
        listInstances: async () => ({ items: [completed, moving] }),
        listUnits: async (id) => [
          {
            instanceId: id,
            unit: "unit",
            slug: "unit",
            branch: "work/unit",
            dependsOn: [],
            rounds: [],
            ...(id === "completed" ? { ending: { kind: "merged", at: 2, report: "Done" } } : {}),
          },
        ],
      },
      liveUnitKeys: async () => new Set(["moving:unit"]),
    });
    const read = createHomeViewHandler(
      home,
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
    );
    const finished = response();
    read(request("/pipelines/completed?attentionRecipient=person:foreign"), finished.res, {
      actor: viewer,
      organization: "installation-a",
      attentionRecipient: "person:alice",
    });
    await finished.ended;
    expect(finished.value().status).toBe(200);
    expect(JSON.parse(finished.value().body)).toMatchObject({
      page: "fleetPipeline",
      status: "complete",
      attentionRecipient: "person:alice",
      pipeline: { unresolved: 0, units: [{ unit: { unit: "completed:unit" } }] },
    });
    const active = response();
    read(request("/pipelines/moving"), active.res, { actor: viewer, organization: "installation-a" });
    await active.ended;
    expect(JSON.parse(active.value().body)).toMatchObject({
      page: "fleetPipeline",
      pipeline: { units: [{ unit: { unit: "moving:unit" }, activity: "moving" }] },
    });
  });
  it("returns unavailable rather than not found when canonical pipeline lookup is incomplete", async () => {
    const home = createHomeService({
      organizationId: "installation-a",
      maxPages: 1,
      instances: { listInstances: async () => ({ items: [], cursor: "more" }), listUnits: async () => [] },
    });
    const read = createHomeViewHandler(
      home,
      makePageSender({ js: "/assets/green.js", css: [] }, ALL_CAPABILITIES),
      "installation-a",
    );
    const output = response();
    read(request("/pipelines/not-yet-read"), output.res, { actor: viewer, organization: "installation-a" });
    await output.ended;
    expect(output.value()).toEqual({ status: 503, body: "Work is unavailable." });
  });
});
