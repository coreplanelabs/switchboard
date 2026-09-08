import { describe, expect, it, vi } from "vitest";
import { ALL_GRANTS } from "../authz/grants.js";
import type { Actor } from "../authz/types.js";
import { ALL_CAPABILITIES, type Capabilities } from "../capabilities.js";
import { CommandRegistry, UNTRUSTED_OPEN, wrapUntrusted, type Caller, type JsonValue } from "../commandRegistry.js";
import { ReviewAbridger } from "../reviewAbridge.js";
import { RunRegistry } from "../runRegistry.js";
import { InMemoryRunStore } from "../runStore.js";
import { createRunsService } from "../runsService.js";
import { fakeAbridger, NOW, PLANTED_TEXT, record, REVIEW_DIFF, reviewRecord } from "../testing/conformanceFixture.js";
import {
  ABRIDGE_OFF_MESSAGE,
  abridgeOutput,
  registerReviewCommands,
  renderAbridge,
  type ReviewCommandDeps,
} from "./review.js";

// Feature: docs/reference/specs/reading-diff.md item 9 — `review abridge <id>`: the
// registry command over the ONE abridge path. What it decides: who may ask
// (the `review:write` row; the run must be visible to the caller), how the
// state is answered (`running` marker, `done` summary, `failed` reason,
// `--wait` for the outcome), and that the summary leaves wrapped as untrusted.

const admin: Actor = { kind: "user", id: "slack:UADMIN", grants: ALL_GRANTS };
const member: Actor = {
  kind: "user",
  id: "slack:UBOB",
  grants: { actions: new Set(["runs:read", "review:write"]), channels: new Set(["slack:C1"]), repos: new Set() },
};
const outsider: Actor = {
  kind: "user",
  id: "slack:UEVE",
  grants: { actions: new Set(["review:write"]), channels: new Set(), repos: new Set() },
};
const caller = (actor: Actor): Caller => ({ kind: "chat", id: actor.id, actor });

async function setup(over: Partial<ReviewCommandDeps["review"]> = {}) {
  const store = new InMemoryRunStore({ now: () => NOW });
  await store.put(reviewRecord("rev-1", NOW - 3000));
  await store.put({ ...record("cod-1", NOW - 4000), channelVisibility: "private" });
  const abridger = fakeAbridger(store);
  const reg = new RunRegistry({ genId: () => "live-1", genToken: () => "t", now: () => NOW });
  const runs = createRunsService({ registry: reg, store, clock: () => NOW });
  const registry = new CommandRegistry<ReviewCommandDeps>({ audit: () => {}, logError: () => {} });
  registerReviewCommands(registry);
  const deps: ReviewCommandDeps = { review: { abridger: async () => abridger, runs: async () => runs, ...over } };
  const invoke = (input: { args?: unknown[]; options?: Record<string, unknown> }, as: Actor = admin) =>
    registry.invoke("review.abridge", input, caller(as), deps);
  return { store, abridger, invoke, registry, deps };
}

describe("review.abridge", () => {
  it("answers the in-progress marker, then the stored artifact's summary (wrapped as untrusted) once done; the diff stays on the record", async () => {
    const { invoke, abridger, store } = await setup();
    expect(await invoke({ args: ["rev-1"] })).toEqual({
      ok: true,
      value: { id: "rev-1", state: "running", startedAt: NOW },
    });
    await abridger.settled();
    const done = await invoke({ args: ["rev-1"] });
    expect(done).toMatchObject({
      ok: true,
      value: {
        id: "rev-1",
        state: "done",
        reused: true,
        artifact: {
          model: "claude-opus-5",
          input: "github-compare",
          inputBytes: Buffer.byteLength(REVIEW_DIFF),
          diffChars: `abridged ${REVIEW_DIFF.length}`.length,
          truncated: false,
          meatTokens: { input: 9, output: 3 },
        },
      },
    });
    const summary = (done as unknown as { value: { artifact: { summary: string } } }).value.artifact.summary;
    expect(summary).toContain(UNTRUSTED_OPEN);
    expect(summary).toContain(PLANTED_TEXT);
    expect(JSON.stringify(done)).not.toContain("abridged "); // the diff is not in the answer
    expect((await store.get("rev-1"))!.events.at(-1)).toMatchObject({
      poweredBy: "meat",
      diff: `abridged ${REVIEW_DIFF.length}`,
    });
  });

  it("--wait blocks for the outcome; --force recomputes a stored one", async () => {
    const { invoke, abridger } = await setup();
    const spy = vi.spyOn(abridger, "abridge");
    expect(await invoke({ args: ["rev-1"], options: { wait: true } })).toMatchObject({
      ok: true,
      value: { state: "done", reused: false },
    });
    expect(
      await invoke({ args: ["rev-1"], options: { wait: true, force: true, model: "claude-opus-4-8" } }),
    ).toMatchObject({
      ok: true,
      value: { state: "done", reused: false, artifact: { model: "claude-opus-4-8" } },
    });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      { runId: "rev-1", model: undefined, force: undefined },
      { runId: "rev-1", model: "claude-opus-4-8", force: true },
    ]);
  });

  it("a run with no reading diff is a conflict naming the rule; an unknown run is not_found", async () => {
    const { invoke } = await setup();
    expect(await invoke({ args: ["cod-1"] })).toMatchObject({
      ok: false,
      error: "conflict",
      message: "run cod-1 carries no reading diff — only PR review runs record one",
    });
    expect(await invoke({ args: ["nope"] })).toMatchObject({ ok: false, error: "not_found" });
  });

  it("the run must be visible to the caller: a holder of the grant who cannot read a private run gets not_found, a member of its channel proceeds", async () => {
    const { invoke, store } = await setup();
    await store.put({ ...reviewRecord("rev-priv", NOW - 5000), channelId: "slack:C1", channelVisibility: "private" });
    expect(await invoke({ args: ["rev-priv"] }, outsider)).toMatchObject({ ok: false, error: "not_found" });
    expect(await invoke({ args: ["rev-priv"] }, member)).toMatchObject({ ok: true, value: { state: "running" } });
  });

  it("without the review:write grant the registry refuses before anything runs", async () => {
    const { invoke, abridger } = await setup();
    const spy = vi.spyOn(abridger, "abridge");
    const reader: Actor = { ...member, grants: { ...member.grants, actions: new Set(["runs:read"]) } };
    expect(await invoke({ args: ["rev-1"] }, reader)).toMatchObject({ ok: false, error: "unauthorized" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("no abridger (the capability's Null Object) is unavailable, naming the three facts and run history", async () => {
    const { invoke } = await setup({ abridger: async () => undefined });
    expect(await invoke({ args: ["rev-1"] })).toMatchObject({
      ok: false,
      error: "unavailable",
      message: ABRIDGE_OFF_MESSAGE,
    });
  });

  it("settle: a `running` acknowledgement is followed by the outcome as a second reply; anything else adds nothing", async () => {
    const { registry, deps, invoke } = await setup();
    expect(registry.settles("review.abridge")).toBe(true);
    const ack = await invoke({ args: ["rev-1"] });
    const followUp = await registry.settle("review.abridge", (ack as { value: JsonValue }).value, caller(admin), deps);
    expect(followUp).toEqual({
      ok: true,
      text: expect.stringMatching(
        /^Abridged reading diff for run rev-1: done\nmodel: claude-opus-5 · input: github-compare/,
      ),
    });
    const done = await invoke({ args: ["rev-1"] });
    expect(
      await registry.settle("review.abridge", (done as { value: JsonValue }).value, caller(admin), deps),
    ).toBeUndefined();
  });

  it("abridgeOutput is plain JSON: the done shape round-trips byte-for-byte and carries only the artifact's declared fields", () => {
    const out = abridgeOutput("r", {
      state: "done",
      reused: true,
      artifact: {
        model: "m",
        summary: "one line",
        input: "recorded",
        inputBytes: 10,
        diffChars: 5,
        truncated: false,
        meatTokens: { input: 1, output: 2 },
      },
    });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    expect(out).toEqual({
      id: "r",
      state: "done",
      reused: true,
      artifact: {
        model: "m",
        summary: wrapUntrusted("one line"),
        input: "recorded",
        inputBytes: 10,
        diffChars: 5,
        truncated: false,
        meatTokens: { input: 1, output: 2 },
      },
    });
    // Absent optional fields stay absent — never `undefined` keys, which JSON would drop silently.
    const bare = abridgeOutput("r", { state: "done", reused: false, artifact: { diffChars: 1, truncated: true } });
    expect(Object.keys((bare as { artifact: object }).artifact)).toEqual(["diffChars", "truncated"]);
  });

  it("renders each state as one legible text", () => {
    expect(renderAbridge({ id: "r", state: "running", startedAt: 1 })).toBe(
      "Abridging the reading diff of run r — running (ask again for the result).",
    );
    expect(renderAbridge({ id: "r", state: "failed", reason: "meat exited 1: boom", at: 1 })).toBe(
      "Abridged reading diff for run r: failed — meat exited 1: boom",
    );
    expect(
      renderAbridge({
        id: "r",
        state: "done",
        reused: true,
        artifact: { model: "m", input: "recorded", inputBytes: 10, diffChars: 5, truncated: true, summary: "s" },
      }),
    ).toBe(
      "Abridged reading diff for run r: done (already stored)\nmodel: m · input: recorded (10 bytes) · abridged: 5 chars (capped)\ns",
    );
  });

  it("is hidden when run history is off, and when the readingDiffAbridge capability is off — present only with both", () => {
    const under = (caps: Partial<Capabilities>) => {
      const registry = new CommandRegistry<ReviewCommandDeps>({
        audit: () => {},
        capabilities: { ...ALL_CAPABILITIES, ...caps },
      });
      registerReviewCommands(registry);
      return registry.get("review.abridge");
    };
    expect(under({ runHistory: false })).toBeUndefined();
    expect(under({ readingDiffAbridge: false })).toBeUndefined();
    expect(under({})).toBeDefined();
    expect(ReviewAbridger).toBeDefined();
  });
});
