import { describe, expect, it } from "vitest";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { InMemoryCoordinatorInstanceStore, NullCoordinatorInstanceStore } from "./instanceStore.js";
import { handOffToCoordinator, type HandOffDeps, type HandOffInput } from "./handOff.js";
import type { CreateInstanceAnswer, InstanceStatusAnswer } from "./instancesRoute.js";
import { MAX_FILE_CHARS } from "../../execution/githubApi.js";
import { PLAN_MAX_CHARS } from "../ship/contract.js";

// Feature: docs/reference/specs/agent-ship.md item 16 — every `agent:ship`
// request the preflight admitted is handed to the plan runner: the bot writes
// the instance record and one unit row per selected unit (a task string is a
// plan of one unit; a resume at review is that unit with the pull request on
// its row), asks its shim for the Workflow
// instance under the plan's id — or, when an earlier attempt's records are
// there, asks its status first: a live attempt refuses the request, a leftover
// is replaced, an ended attempt is resumed as the next under the attempt's id
// with the merged units skipped — and answers the thread with where the plan
// runs. Every refusal is a reply, never a throw, and nothing is created on one.

const NOW = 1_700_000_000_000;
const PLAN = [
  "# Fixture - Plan",
  "",
  "### U10. Warm the cache on wake",
  "",
  "- **Dependencies**: none.",
  "",
  "### U11. Retire the alarm",
  "",
  "- **Dependencies**: U10.",
  "",
  "### U12. Trim the log",
  "",
  "- **Dependencies**: none.",
  "",
].join("\n");

function input(over: Partial<HandOffInput> = {}): HandOffInput {
  return {
    entry: { repo: "acme/api", branch: "ship/warm-the-cache-abc123", base: "main" },
    requestText: "in acme/api: plan docs/plans/fixture.md",
    msg: {
      channelId: "slack:C1",
      channelName: "general",
      userId: "slack:UALICE",
      userName: "alice",
      threadKey: "slack:C1:1.0",
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
    },
    runId: "run-s",
    label: "*ship* · acme/api",
    caps: { maxRounds: 3, maxMinutes: 45 },
    card: { channel: "C1", ts: "1.5" },
    now: NOW,
    ...over,
  };
}

function harness(
  over: {
    files?: Record<string, string>;
    create?: CreateInstanceAnswer | Error;
    /** The shim's status of an earlier attempt's instance, by id; `absent` when unscripted. */
    status?: Record<string, InstanceStatusAnswer>;
    store?: HandOffDeps["instances"];
  } = {},
) {
  const files = over.files ?? { "docs/plans/fixture.md": PLAN };
  const instances = over.store ?? new InMemoryCoordinatorInstanceStore();
  const created: string[] = [];
  const statusAsked: string[] = [];
  const reads: Array<[string, string, string]> = [];
  const deps: HandOffDeps = {
    // The App's read as `GithubApi.readFile` answers it: clipped at the caller's
    // bound (the tool clip when none is given), `truncated` saying so.
    readFile: async (repo, path, ref, opts) => {
      reads.push([repo, path, ref]);
      const content = files[path];
      if (content === undefined) throw new Error(`HTTP 404 Not Found: ${path}`);
      const maxChars = opts?.maxChars ?? MAX_FILE_CHARS;
      return content.length > maxChars ? { content: content.slice(0, maxChars), truncated: true } : { content };
    },
    instances,
    create: async (id) => {
      created.push(id);
      const answer = over.create ?? { kind: "created", id };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    status: async (id) => {
      statusAsked.push(id);
      return over.status?.[id] ?? { kind: "absent" };
    },
    log: () => {},
  };
  return { deps, instances, created, statusAsked, reads };
}

describe("handOffToCoordinator — the ship request as a plan runner instance (item 16)", () => {
  it("a plan request: the plan is read at the base ref, the instance is written under the plan's id with the requester, thread, card, caps and run id, one row per unit in the plan's order, the Workflow instance is created, and the reply says where the plan runs", async () => {
    const h = harness();
    const out = await handOffToCoordinator(h.deps, input());
    expect(out.status).toBe("completed");
    expect(out.reply).toBe(
      "🧭 Handed to the plan runner.\n• plan `fixture` (`docs/plans/fixture.md` at `main`)\n• 3 units in dependency order: U10, U11, U12\n" +
        "• each unit runs in a thread of its own in this channel under your grants; this card follows the plan and its summary lands in this thread",
    );
    expect(h.reads).toEqual([["acme/api", "docs/plans/fixture.md", "main"]]);
    expect(h.created).toEqual(["plan-fixture"]);
    const instance = await h.instances.get("plan-fixture");
    expect(instance).toEqual({
      id: "plan-fixture",
      kind: "ship",
      userId: "slack:UALICE",
      userName: "alice",
      channelId: "slack:C1",
      channelName: "general",
      threadKey: "slack:C1:1.0",
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
      repo: "acme/api",
      branch: "plan/fixture/u10-warm-the-cache-on-wake",
      base: "main",
      createdAt: NOW,
      plan: { id: "fixture", path: "docs/plans/fixture.md" },
      merge: "runner",
      addressSeverity: "minor",
      addressSeveritySource: "org",
      grant: { renewals: 0 },
      grantSource: "org",
      verbosity: "quiet",
      // Absent on the input: zero days — nothing idles (record 0051).
      idleDays: 0,
      caps: { maxRounds: 3, maxMinutes: 45 },
      card: { channel: "C1", ts: "1.5" },
      runId: "run-s",
      label: "*ship* · acme/api",
    } satisfies CoordinatorInstance);
    const rows = await h.instances.listUnits("plan-fixture");
    expect(rows).toEqual([
      {
        instanceId: "plan-fixture",
        unit: "U10",
        slug: "u10-warm-the-cache-on-wake",
        title: "Warm the cache on wake",
        branch: "plan/fixture/u10-warm-the-cache-on-wake",
        dependsOn: [],
        rounds: [],
      },
      {
        instanceId: "plan-fixture",
        unit: "U11",
        slug: "u11-retire-the-alarm",
        title: "Retire the alarm",
        branch: "plan/fixture/u11-retire-the-alarm",
        dependsOn: ["U10"],
        rounds: [],
      },
      {
        instanceId: "plan-fixture",
        unit: "U12",
        slug: "u12-trim-the-log",
        title: "Trim the log",
        branch: "plan/fixture/u12-trim-the-log",
        dependsOn: [],
        rounds: [],
      },
    ] satisfies CoordinatorUnit[]);
  });

  it("a selection narrows the rows to the named units in the plan's order, a dependency outside it kept on the row as the plan states it; a unit the plan lacks is a refusal naming it and nothing is written or created", async () => {
    const h = harness();
    const out = await handOffToCoordinator(
      h.deps,
      input({ requestText: "in acme/api: plan docs/plans/fixture.md units U12, U11" }),
    );
    expect(out.status).toBe("completed");
    expect(out.reply).toContain("• 2 units in dependency order: U11, U12");
    expect((await h.instances.listUnits("plan-fixture")).map((u) => [u.unit, u.dependsOn])).toEqual([
      ["U11", ["U10"]],
      ["U12", []],
    ]);
    const missing = harness();
    const refused = await handOffToCoordinator(
      missing.deps,
      input({ requestText: "in acme/api: plan docs/plans/fixture.md units U99" }),
    );
    expect(refused.status).toBe("aborted");
    expect(refused.reply).toContain("🚫");
    expect(refused.reply).toContain("U99");
    expect(missing.created).toEqual([]);
    expect(await missing.instances.get("plan-fixture")).toBeNull();
  });

  it("a seeded plan selecting exactly one unit takes the task path's wording: the reply says the unit runs on its branch in this thread and the report lands here — never a thread per unit or a summary here (agent-ship item 16)", async () => {
    const h = harness();
    const out = await handOffToCoordinator(
      h.deps,
      input({ requestText: "in acme/api: plan docs/plans/fixture.md units U12" }),
    );
    expect(out.status).toBe("completed");
    expect(out.reply).toBe(
      "🧭 Handed to the plan runner.\n• plan `fixture` (`docs/plans/fixture.md` at `main`)\n• 1 unit in dependency order: U12\n" +
        "• the unit runs on `plan/fixture/u12-trim-the-log` in this thread under your grants; this card follows the plan and its report lands here",
    );
    expect((await h.instances.listUnits("plan-fixture")).map((u) => u.unit)).toEqual(["U12"]);
  });

  it("a task request is a generated plan of one unit: the instance under `plan-<slug>-<hash>` carries `plan: { id }` with no `path` and `merge: person`, its one `U1` row is on `plan/<id>/u1`, and the reply says the unit runs in this thread — a task whose text contains the word runner included", async () => {
    const h = harness();
    const id = "plan-warm-the-cache-on-wake-dfa06c";
    const out = await handOffToCoordinator(
      h.deps,
      input({ entry: { repo: "acme/api", base: "main" }, requestText: "in acme/api: warm the cache on wake" }),
    );
    expect(out.status).toBe("completed");
    expect(out.reply).toBe(
      "🧭 Handed to the plan runner.\n• plan `warm-the-cache-on-wake-dfa06c`\n• the unit runs on `plan/warm-the-cache-on-wake-dfa06c/u1` in this thread under your grants; this card follows it and the report lands here",
    );
    expect(h.reads).toEqual([]);
    expect(h.created).toEqual([id]);
    const instance = (await h.instances.get(id))!;
    expect(instance).toMatchObject({
      id,
      branch: "plan/warm-the-cache-on-wake-dfa06c/u1",
      base: "main",
      runId: "run-s",
      merge: "person",
      plan: { id: "warm-the-cache-on-wake-dfa06c" },
    });
    expect("path" in instance.plan!).toBe(false);
    expect(await h.instances.listUnits(id)).toEqual([
      {
        instanceId: id,
        unit: "U1",
        slug: "u1",
        title: "warm the cache on wake",
        branch: "plan/warm-the-cache-on-wake-dfa06c/u1",
        dependsOn: [],
        rounds: [],
      },
    ]);
    // The field comes from the request's kind, never its words: "runner" in the text stays a person's merge.
    const wordy = harness();
    await handOffToCoordinator(
      wordy.deps,
      input({ entry: { repo: "acme/api", base: "main" }, requestText: "in acme/api: make the runner warm the cache" }),
    );
    expect(await wordy.instances.get("plan-make-the-runner-warm-the-eaaa45")).toMatchObject({ merge: "person" });
    expect(await h.instances.listEvents({ instanceId: id, unit: ["U", "1"].join("") })).toEqual([]);
  });

  it("a generated task persists its accepted inline media as one retry-stable seed event after the unit row and before the Workflow starts; an over-cap seed says what was dropped", async () => {
    const h = harness();
    let creates = 0;
    let instanceId = "";
    const unit = ["U", "1"].join("");
    h.deps.create = async (id) => {
      instanceId = id;
      expect(await h.instances.listUnits(id)).toHaveLength(1);
      expect(await h.instances.listEvents({ instanceId: id, unit })).toHaveLength(1);
      return creates++ === 0 ? { kind: "failed", id, reason: "engine warming" } : { kind: "created", id };
    };
    const req = input({
      entry: { repo: "acme/api", base: "main" },
      requestText:
        "in acme/api: match the screenshot\n\n(Note: 1 attachment(s) could not be passed through: archive.zip — unsupported type)",
    });
    const shot = { mediaType: "image/png", data: "aGk=", name: "brief.png" };
    const oversized = { mediaType: "application/pdf", data: "x".repeat(500 * 1024), name: "huge.pdf" };
    (req.msg as typeof req.msg & { images: (typeof shot)[]; documents: (typeof oversized)[] }).images = [shot];
    (req.msg as typeof req.msg & { images: (typeof shot)[]; documents: (typeof oversized)[] }).documents = [oversized];

    const first = await handOffToCoordinator(h.deps, req);
    expect(first.status).toBe("aborted");
    expect(instanceId).not.toBe("");
    const key = { instanceId, unit };
    expect(await h.instances.listEvents(key)).toEqual([
      {
        seq: 1,
        id: `${instanceId}:${unit}:ship-request`,
        sender: "slack:UALICE",
        senderName: "alice",
        text: "Attachments from the ship request.",
        attachmentsDropped: 2,
        mode: "steer",
        at: NOW,
      },
    ]);
    const retry = await handOffToCoordinator(h.deps, req);
    expect(retry.status).toBe("completed");
    expect(await h.instances.listEvents(key)).toHaveLength(1);
  });

  it("a base the preflight fell back from (issue 1827) is named on the reply's FIRST plan line — the missing ref and the default branch the plan runs on", async () => {
    const h = harness();
    const out = await handOffToCoordinator(
      h.deps,
      input({
        entry: { repo: "acme/api", base: "main", baseFallback: { requested: "web/src/pages/runPage.test.ts" } },
        requestText: "in acme/api: warm the cache on wake",
      }),
    );
    expect(out.status).toBe("completed");
    const [headline, first] = out.reply.split("\n");
    expect(headline).toBe("\ud83e\udded Handed to the plan runner.");
    expect(first).toBe(
      "\u2022 plan `warm-the-cache-on-wake-dfa06c` \u2014 `web/src/pages/runPage.test.ts` is not a branch of the repository, so the plan runs on the default branch `main`",
    );
  });

  it("a task's urls reach the unit: a Slack `<url|label>` link is unwrapped to its bare url and kept in the unit's title and id text, the `in <repo>:` prefix alone is dropped — the entry probe's stripped text is never the unit", async () => {
    const h = harness();
    const out = await handOffToCoordinator(
      h.deps,
      input({
        entry: { repo: "acme/api", base: "main" },
        requestText: "in acme/api: point the redirect at <https://calendar.acme.test/TrrMBAg7|calendar.acme.test/…>",
      }),
    );
    expect(out.status).toBe("completed");
    const [id] = h.created;
    const [row] = await h.instances.listUnits(id!);
    // The title is the text's first line (cut at 80 by unitTitleOf); the child's
    // contract carries the whole text (briefs.test.ts).
    expect(row!.title).toBe("point the redirect at https://calendar.acme.test/TrrMBAg7");
    expect(id).toMatch(/^plan-point-the-redirect-at-ht-[0-9a-f]{6}$/);
  });

  it("a generated plan is re-issued by its id: the same text after `U1` merged is refused as merged already; after `U1` ended `merge_ready` it is attempt 2 under `plan-<id>-2` with `U1` selected on the same branch", async () => {
    const id = "plan-warm-the-cache-on-wake-dfa06c";
    const req = input({
      entry: { repo: "acme/api", base: "main" },
      requestText: "in acme/api: warm the cache on wake",
    });
    const merged = harness({ status: { [id]: { kind: "status", status: "complete" } } });
    await handOffToCoordinator(merged.deps, req);
    const rows = await merged.instances.listUnits(id);
    await merged.instances.putUnits([
      { ...rows[0]!, ending: { kind: "merged", at: NOW } as unknown as CoordinatorUnit["ending"] },
    ]);
    const again = await handOffToCoordinator(merged.deps, req);
    expect(again.status).toBe("aborted");
    expect(again.reply).toContain("merged already");
    expect(merged.created).toEqual([id]);

    const ready = harness({ status: { [id]: { kind: "status", status: "complete" } } });
    await handOffToCoordinator(ready.deps, req);
    const readyRows = await ready.instances.listUnits(id);
    await ready.instances.putUnits([
      { ...readyRows[0]!, ending: { kind: "merge_ready", at: NOW } as unknown as CoordinatorUnit["ending"] },
    ]);
    const attempt2 = await handOffToCoordinator(ready.deps, req);
    expect(attempt2.status).toBe("completed");
    expect(attempt2.instanceId).toBe(`${id}-2`);
    expect(attempt2.reply).toContain("• attempt 2 of plan `");
    expect(await ready.instances.get(`${id}-2`)).toMatchObject({ attempt: 2, merge: "person" });
    expect(await ready.instances.listUnits(`${id}-2`)).toMatchObject([
      { unit: "U1", branch: "plan/warm-the-cache-on-wake-dfa06c/u1" },
    ]);
  });

  it("a re-issue after a review_pending ending carries the row's lastPush — the coding child's own last push — onto the next attempt's row, so its pre-check starts at the review round", async () => {
    const id = "plan-warm-the-cache-on-wake-dfa06c";
    const req = input({
      entry: { repo: "acme/api", base: "main" },
      requestText: "in acme/api: warm the cache on wake",
    });
    const h = harness({ status: { [id]: { kind: "status", status: "complete" } } });
    await handOffToCoordinator(h.deps, req);
    const rows = await h.instances.listUnits(id);
    await h.instances.putUnits([
      {
        ...rows[0]!,
        lastPush: "abcdef1234abcdef1234abcdef1234abcdef1234",
        ending: { kind: "review_pending", at: NOW } as unknown as CoordinatorUnit["ending"],
      },
    ]);
    const attempt2 = await handOffToCoordinator(h.deps, req);
    expect(attempt2.status).toBe("completed");
    // The same unit, on attempt 2's row, carrying the head attempt 1 recorded.
    expect(await h.instances.listUnits(`${id}-2`)).toMatchObject([
      { unit: rows[0]!.unit, lastPush: "abcdef1234abcdef1234abcdef1234abcdef1234" },
    ]);
  });

  it("a resume at review (agent-ship item 10) is the one generated unit with the pull request on its row and the entry's branch — the pull request's own head — so the runner opens it at the review round; the reply names the pull request and that no coding round runs first", async () => {
    const h = harness();
    const id = "plan-implement-the-task-this-f502bc";
    const out = await handOffToCoordinator(
      h.deps,
      input({
        entry: {
          repo: "acme/api",
          branch: "feat/wake-cache",
          base: "main",
          resume: { pr: 7, headSha: "a".repeat(40), url: "https://github.com/acme/api/pull/7" },
        },
        requestText: "https://github.com/acme/api/pull/7",
      }),
    );
    expect(out.status).toBe("completed");
    expect(out.reply).toContain("🧭 Handed to the plan runner.");
    expect(out.instanceId).toBe(id);
    expect(out.reply).toContain(
      "the review loop of https://github.com/acme/api/pull/7 resumes at its next review round on `feat/wake-cache` in this thread under your grants — no new coding round first",
    );
    expect(h.created).toEqual([id]);
    expect(await h.instances.listUnits(id)).toMatchObject([
      {
        instanceId: id,
        unit: "U1",
        slug: "u1",
        branch: "feat/wake-cache",
        dependsOn: [],
        rounds: [],
        resume: { pr: 7, headSha: "a".repeat(40), url: "https://github.com/acme/api/pull/7" },
      },
    ]);
    // Without a url the reply builds the pull request's from the number.
    const bare = harness();
    const again = await handOffToCoordinator(
      bare.deps,
      input({
        entry: { repo: "acme/api", branch: "feat/wake-cache", base: "main", resume: { pr: 9 } },
        requestText: "acme/api#9",
      }),
    );
    expect(again.reply).toContain("the review loop of https://github.com/acme/api/pull/9 resumes");
    expect((await bare.instances.listUnits(id))[0]!.resume).toEqual({ pr: 9 });
  });

  it("refusals before anything is written: a plan file the repository does not have at the base, a plan whose name is not a plan id, no base branch, a plan without units; each names the reason and creates nothing", async () => {
    const cases: Array<[Partial<HandOffInput>, RegExp]> = [
      [
        { requestText: "in acme/api: plan docs/plans/missing.md" },
        /🚫 The plan `docs\/plans\/missing\.md` could not be read at `main` in acme\/api: HTTP 404/,
      ],
      [{ requestText: "in acme/api: plan docs/plans/Bad_Name.md" }, /🚫 .*plan id/i],
      [{ entry: { repo: "acme/api", branch: "ship/x", base: undefined } }, /🚫 .*no base branch/],
      [{ requestText: "in acme/api: plan docs/plans/empty.md" }, /🚫 .*no unit/i],
    ];
    for (const [over, expected] of cases) {
      const h = harness({
        files: { "docs/plans/fixture.md": PLAN, "docs/plans/empty.md": "# Empty - Plan\n\nNothing here.\n" },
      });
      const out = await handOffToCoordinator(h.deps, input(over));
      expect(out.status, JSON.stringify(over)).toBe("aborted");
      expect(out.reply, JSON.stringify(over)).toMatch(expected);
      expect(h.created, JSON.stringify(over)).toEqual([]);
      expect(await h.instances.listUnits("plan-fixture")).toEqual([]);
    }
  });

  it("the store decides first: a process without a durable instance store refuses by name and creates nothing; a record left by an earlier attempt whose create failed — the shim knows no such instance — is replaced with this request's record and rows under the same id, and the reply says so", async () => {
    const noStore = harness({ store: new NullCoordinatorInstanceStore() });
    const out = await handOffToCoordinator(noStore.deps, input());
    expect(out.status).toBe("aborted");
    expect(out.reply).toContain("⚠️ The plan runner needs run history on the state Worker");
    expect(noStore.created).toEqual([]);
    const leftover = new InMemoryCoordinatorInstanceStore();
    const first = await handOffToCoordinator(
      harness({ store: leftover, create: { kind: "failed", id: "plan-fixture", reason: "engine down" } }).deps,
      input(),
    );
    expect(first.status).toBe("aborted");
    expect(first.reply).toBe(
      "⚠️ The plan runner could not be started: engine down. Nothing ran; re-issue the request to try again.",
    );
    const second = harness({ store: leftover, status: { "plan-fixture": { kind: "absent" } } });
    const retried = await handOffToCoordinator(
      second.deps,
      input({ runId: "run-s2", now: NOW + 1, requestText: "in acme/api: plan docs/plans/fixture.md units U10, U11" }),
    );
    expect(retried.status).toBe("completed");
    expect(retried.reply).toBe(
      "🧭 Handed to the plan runner.\n• plan `fixture` (`docs/plans/fixture.md` at `main`)\n• 2 units in dependency order: U10, U11\n" +
        "• each unit runs in a thread of its own in this channel under your grants; this card follows the plan and its summary lands in this thread\n• the records of an earlier attempt that never started were replaced",
    );
    expect(second.statusAsked).toEqual(["plan-fixture"]);
    expect(second.created).toEqual(["plan-fixture"]);
    expect(await leftover.get("plan-fixture")).toMatchObject({
      id: "plan-fixture",
      runId: "run-s2",
      createdAt: NOW + 1,
    });
    expect((await leftover.get("plan-fixture"))?.attempt).toBeUndefined();
    expect((await leftover.listUnits("plan-fixture")).map((u) => u.unit)).toEqual(["U10", "U11"]);
  });

  it("a live runner's records are never touched: a re-issue for a plan whose latest attempt still runs is refused naming the instance and its status, writes nothing and asks for no instance", async () => {
    const live = new InMemoryCoordinatorInstanceStore();
    const started = await handOffToCoordinator(harness({ store: live }).deps, input());
    expect(started.status).toBe("completed");
    // The runner has been at work: threads, rounds, a pull request and an ending on the rows.
    const rows = await live.listUnits("plan-fixture");
    const inFlight: CoordinatorUnit[] = [
      {
        ...rows[0]!,
        threadKey: "slack:C1:2.0",
        pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
        rounds: [{ index: 0, agent: "coding", outcome: "pr_opened", at: NOW + 5 }],
        ending: { kind: "merged", report: "✅ Merged", at: NOW + 9 },
      },
      {
        ...rows[1]!,
        threadKey: "slack:C1:3.0",
        rounds: [{ index: 0, agent: "coding", outcome: "started", at: NOW + 10 }],
      },
      rows[2]!,
    ];
    await live.putUnits(inFlight);
    for (const status of ["running", "waiting", "queued", "paused", "waitingForPause"]) {
      const again = harness({ store: live, status: { "plan-fixture": { kind: "status", status } } });
      const refused = await handOffToCoordinator(
        again.deps,
        input({ runId: "run-s2", now: NOW + 20, msg: { ...input().msg, threadKey: "slack:C1:9.0" } }),
      );
      expect(refused.status, status).toBe("aborted");
      expect(refused.reply, status).toBe(
        `🚫 A runner for plan \`fixture\` is still running (\`plan-fixture\`, status: ${status}): wait for it to end — or terminate it in the Workflows dashboard — before re-issuing.`,
      );
      expect(again.created).toEqual([]);
    }
    expect(await live.listUnits("plan-fixture")).toEqual(inFlight);
    expect((await live.get("plan-fixture"))?.runId).toBe("run-s");
    // A state the bot does not read as ended, and a shim that could not say: refused by reason, nothing written.
    const odd = harness({ store: live, status: { "plan-fixture": { kind: "status", status: "unknown" } } });
    expect((await handOffToCoordinator(odd.deps, input({ runId: "run-s3" }))).reply).toContain(
      "a state the bot does not read as ended (unknown)",
    );
    const mute = harness({
      store: live,
      status: { "plan-fixture": { kind: "unanswered", reason: "the shim could not be reached: ECONNREFUSED" } },
    });
    expect((await handOffToCoordinator(mute.deps, input({ runId: "run-s4" }))).reply).toBe(
      "⚠️ The plan runner could not tell whether `plan-fixture` still runs: the shim could not be reached: ECONNREFUSED. Nothing ran; re-issue the request to try again.",
    );
    expect(odd.created).toEqual([]);
    expect(mute.created).toEqual([]);
    expect((await live.get("plan-fixture"))?.runId).toBe("run-s");
  });

  it("a plan whose latest attempt ended is resumed as the next attempt: the units the earlier attempts merged are skipped, the rest run under `plan-<plan-id>-<n>` with the attempt on the record, a dependency on a merged unit stays on the row and counts as done, the reply names what is left and what was merged; a third re-issue finds the latest attempt; every named unit merged is a refusal", async () => {
    /** A store holding attempt 1's records, ended: U10 merged, U11's merge refused, U12 capped. */
    async function afterFirstAttempt() {
      const store = new InMemoryCoordinatorInstanceStore();
      expect((await handOffToCoordinator(harness({ store }).deps, input())).status).toBe("completed");
      const rows = await store.listUnits("plan-fixture");
      await store.putUnits([
        { ...rows[0]!, ending: { kind: "merged", report: "✅ Merged", at: NOW + 9 } },
        { ...rows[1]!, ending: { kind: "merge_refused", report: "⚠️ conflict", at: NOW + 19 } },
        { ...rows[2]!, ending: { kind: "aborted", report: "⚠️ cap", at: NOW + 29 } },
      ]);
      return store;
    }
    for (const ended of ["complete", "errored", "terminated"]) {
      const store = await afterFirstAttempt();
      const resume = harness({ store, status: { "plan-fixture": { kind: "status", status: ended } } });
      const out = await handOffToCoordinator(resume.deps, input({ runId: "run-s2", now: NOW + 100 }));
      expect(out.status, ended).toBe("completed");
      expect(out.reply, ended).toBe(
        "🧭 Handed to the plan runner.\n• attempt 2 of plan `fixture` (`docs/plans/fixture.md` at `main`)\n• 2 units left in dependency order: U11, U12\n• merged before: U10\n" +
          "• each unit runs in a thread of its own in this channel under your grants; this card follows the plan and its summary lands in this thread",
      );
      expect(resume.statusAsked).toEqual(["plan-fixture"]);
      expect(resume.created).toEqual(["plan-fixture-2"]);
      expect(await store.get("plan-fixture-2")).toMatchObject({
        id: "plan-fixture-2",
        attempt: 2,
        runId: "run-s2",
        plan: { id: "fixture", path: "docs/plans/fixture.md" },
        branch: "plan/fixture/u11-retire-the-alarm",
      });
      expect((await store.listUnits("plan-fixture-2")).map((u) => [u.unit, u.dependsOn])).toEqual([
        ["U11", ["U10"]],
        ["U12", []],
      ]);
      // The first attempt's records stand untouched.
      expect((await store.get("plan-fixture"))?.runId).toBe("run-s");
      expect((await store.listUnits("plan-fixture")).map((u) => u.ending?.kind)).toEqual([
        "merged",
        "merge_refused",
        "aborted",
      ]);
    }
    // A third re-issue: attempt 2 ended with U11 merged and U12 capped → attempt 3 runs U12 alone.
    const store = await afterFirstAttempt();
    await handOffToCoordinator(
      harness({ store, status: { "plan-fixture": { kind: "status", status: "complete" } } }).deps,
      input({ runId: "run-s2", now: NOW + 100 }),
    );
    const second = await store.listUnits("plan-fixture-2");
    await store.putUnits([
      { ...second[0]!, ending: { kind: "merged", report: "✅ Merged", at: NOW + 200 } },
      { ...second[1]!, ending: { kind: "aborted", report: "⚠️ cap", at: NOW + 210 } },
    ]);
    const third = harness({ store, status: { "plan-fixture-2": { kind: "status", status: "complete" } } });
    const out = await handOffToCoordinator(third.deps, input({ runId: "run-s3", now: NOW + 300 }));
    expect(out.status).toBe("completed");
    expect(third.statusAsked).toEqual(["plan-fixture-2"]);
    expect(third.created).toEqual(["plan-fixture-3"]);
    expect(out.reply).toContain("attempt 3 of plan `fixture`");
    expect(out.reply).toContain("• 1 unit left in dependency order: U12\n• merged before: U10, U11");
    // One unit left is a one-unit plan: the attempt's reply takes the "in this thread" wording too.
    expect(out.reply).toContain(
      "• the unit runs on `plan/fixture/u12-trim-the-log` in this thread under your grants; this card follows the plan and its report lands here",
    );
    expect((await store.get("plan-fixture-3"))?.attempt).toBe(3);
    // Every unit the request names merged already: nothing to run, nothing written.
    const done = harness({ store, status: { "plan-fixture-3": { kind: "status", status: "complete" } } });
    const nothing = await handOffToCoordinator(
      done.deps,
      input({ runId: "run-s4", requestText: "in acme/api: plan docs/plans/fixture.md units U10, U11" }),
    );
    expect(nothing.status).toBe("aborted");
    expect(nothing.reply).toBe(
      "🚫 Every unit of plan `fixture` this request names is merged already (U10, U11) — nothing left to run.",
    );
    expect(done.created).toEqual([]);
    expect(await store.get("plan-fixture-4")).toBeNull();
  });

  it("a leftover at a later attempt — a resume whose create failed — is replaced under the same attempt id with the units the earlier attempts merged skipped, never rerun; every named unit merged already is a refusal there too", async () => {
    // Attempt 1 ended with U10 merged; the resume to attempt 2 wrote its records but its create failed.
    const store = new InMemoryCoordinatorInstanceStore();
    expect((await handOffToCoordinator(harness({ store }).deps, input())).status).toBe("completed");
    const rows = await store.listUnits("plan-fixture");
    await store.putUnits([
      { ...rows[0]!, ending: { kind: "merged", report: "✅ Merged", at: NOW + 9 } },
      { ...rows[1]!, ending: { kind: "aborted", report: "⚠️ cap", at: NOW + 19 } },
      { ...rows[2]!, ending: { kind: "aborted", report: "⚠️ cap", at: NOW + 29 } },
    ]);
    const failedResume = harness({
      store,
      status: { "plan-fixture": { kind: "status", status: "complete" } },
      create: { kind: "failed", id: "plan-fixture-2", reason: "engine down" },
    });
    expect((await handOffToCoordinator(failedResume.deps, input({ runId: "run-s2", now: NOW + 100 }))).status).toBe(
      "aborted",
    );
    expect((await store.get("plan-fixture-2"))?.attempt).toBe(2);
    // The re-issue: attempt 2's record is there and the shim knows no such instance → replaced, U10 still skipped.
    const again = harness({ store, status: { "plan-fixture-2": { kind: "absent" } } });
    const out = await handOffToCoordinator(again.deps, input({ runId: "run-s3", now: NOW + 200 }));
    expect(out.status).toBe("completed");
    expect(out.reply).toBe(
      "🧭 Handed to the plan runner.\n• attempt 2 of plan `fixture` (`docs/plans/fixture.md` at `main`)\n• 2 units left in dependency order: U11, U12\n• merged before: U10\n" +
        "• each unit runs in a thread of its own in this channel under your grants; this card follows the plan and its summary lands in this thread\n• the records of an earlier attempt that never started were replaced",
    );
    expect(again.statusAsked).toEqual(["plan-fixture-2"]);
    expect(again.created).toEqual(["plan-fixture-2"]);
    expect(await store.get("plan-fixture-2")).toMatchObject({ id: "plan-fixture-2", attempt: 2, runId: "run-s3" });
    expect((await store.listUnits("plan-fixture-2")).map((u) => u.unit)).toEqual(["U11", "U12"]);
    // Named units all merged before: refused, and the leftover left as it was.
    const nothing = await handOffToCoordinator(
      harness({ store, status: { "plan-fixture-2": { kind: "absent" } } }).deps,
      input({ runId: "run-s4", requestText: "in acme/api: plan docs/plans/fixture.md units U10" }),
    );
    expect(nothing.status).toBe("aborted");
    expect(nothing.reply).toBe(
      "🚫 Every unit of plan `fixture` this request names is merged already (U10) — nothing left to run.",
    );
    expect((await store.get("plan-fixture-2"))?.runId).toBe("run-s3");
  });

  it("the shim's other answers: a duplicate instance the state Worker knew nothing of is a refusal a person decides; an unanswered shim and a create that threw are refusals by reason", async () => {
    const dup = harness({ create: { kind: "duplicate", id: "plan-fixture", status: "complete" } });
    const out = await handOffToCoordinator(dup.deps, input());
    expect(out.status).toBe("aborted");
    expect(out.reply).toBe(
      "🚫 A Workflow instance `plan-fixture` already exists on the platform, status: complete but the state Worker knew nothing of it — a person decides; re-issuing will not resume it.",
    );
    const silent = harness({
      create: { kind: "unanswered", reason: "PUBLIC_BASE_URL is not set — the bot cannot address its own shim" },
    });
    expect((await handOffToCoordinator(silent.deps, input())).reply).toBe(
      "⚠️ The plan runner could not be started: PUBLIC_BASE_URL is not set — the bot cannot address its own shim. Nothing ran; re-issue the request to try again.",
    );
    const threw = harness({ create: new Error("boom") });
    expect((await handOffToCoordinator(threw.deps, input())).reply).toContain("could not be started: boom");
  });
});

describe("the severity to address — resolved once, written on the instance beside `merge`", () => {
  it("the hand-off writes the resolved level and its source on the instance; absent, the default (`minor`, org) is written so the machine always reads one value", async () => {
    const h = harness();
    await handOffToCoordinator(h.deps, input({ addressSeverity: { level: "blocking", source: "run" } }));
    expect(await h.instances.get("plan-fixture")).toMatchObject({
      merge: "runner",
      addressSeverity: "blocking",
      addressSeveritySource: "run",
    });
    const d = harness();
    await handOffToCoordinator(d.deps, input());
    expect(await d.instances.get("plan-fixture")).toMatchObject({
      addressSeverity: "minor",
      addressSeveritySource: "org",
    });
  });
});

describe("the grant — resolved once, written on the instance beside `merge` (decision 0046, the renewable lease)", () => {
  it("the hand-off writes the resolved grant and its source on the instance; absent, zero renewals and no cap are written as the org's, so nothing renews by default", async () => {
    const h = harness();
    await handOffToCoordinator(h.deps, input({ grant: { grant: { renewals: 4, costCapUsd: 30 }, source: "channel" } }));
    expect(await h.instances.get("plan-fixture")).toMatchObject({
      grant: { renewals: 4, costCapUsd: 30 },
      grantSource: "channel",
    });
    const d = harness();
    await handOffToCoordinator(d.deps, input());
    expect(await d.instances.get("plan-fixture")).toMatchObject({ grant: { renewals: 0 }, grantSource: "org" });
  });
});

describe("handOffToCoordinator — the plan is read whole, never through the tool clip (item 16)", () => {
  /** A plan whose last unit begins past the tool clip: filler units of prose
   *  until the file is longer than `MAX_FILE_CHARS`, then the unit asked for. */
  const filler = (n: number) =>
    [
      `### U${n}. Filler unit ${n}`,
      "",
      `- **Goal**: ${"the runner reads every unit of a long plan. ".repeat(60)}`,
      "",
      "---",
      "",
    ].join("\n");
  const longPlan = (() => {
    const parts = ["# Long - Plan", ""];
    for (let n = 10; parts.join("\n").length <= MAX_FILE_CHARS; n++) parts.push(filler(n));
    parts.push("### U99. The unit past the clip", "", "- **Goal**: lands.", "- **Dependencies**: none.", "");
    return parts.join("\n");
  })();

  it("a unit whose heading lies past the tool clip is found: the seed asks for the plan up to PLAN_MAX_CHARS, so a plan longer than the clip keeps every unit", async () => {
    expect(longPlan.length).toBeGreaterThan(MAX_FILE_CHARS);
    const h = harness({ files: { "docs/plans/long.md": longPlan } });
    const out = await handOffToCoordinator(
      h.deps,
      input({ requestText: "in acme/api: plan docs/plans/long.md units U99" }),
    );
    expect(out.status).toBe("completed");
    expect(out.reply).toContain("U99");
    expect(await h.instances.get("plan-long")).not.toBeNull();
    expect((await h.instances.listUnits("plan-long")).map((u) => u.unit)).toEqual(["U99"]);
  });

  it("a plan longer than PLAN_MAX_CHARS is refused naming the bound, with nothing created: its later units would be lost, and a short parse is never a plan", async () => {
    const h = harness({ files: { "docs/plans/long.md": longPlan } });
    const clipped: HandOffDeps = {
      ...h.deps,
      readFile: async (repo, path, ref, opts) => {
        const file = await h.deps.readFile(repo, path, ref, opts);
        return { content: file.content, truncated: true };
      },
    };
    const out = await handOffToCoordinator(
      clipped,
      input({ requestText: "in acme/api: plan docs/plans/long.md units U99" }),
    );
    expect(out.status).toBe("aborted");
    expect(out.reply).toBe(
      `🚫 The plan \`docs/plans/long.md\` is longer than ${PLAN_MAX_CHARS.toLocaleString("en-US")} characters at \`main\` in acme/api; its later units would be lost, so nothing was run — split the plan.`,
    );
    expect(h.created).toEqual([]);
    expect(await h.instances.get("plan-long")).toBeNull();
  });
});
