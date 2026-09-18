import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDef } from "../../../../agents/registry.js";
import type { Executor } from "../../../../execution/executor.js";
import { updateStatusTool } from "../../../../tools/status.js";
import { createHarnessRoutesHandler, isHarnessPath } from "../../../../channels/harnessRoutes.js";
import { RunBearerStore, type RunBearerGrant } from "../../../modelProxy/runBearers.js";
import type { RunEvent } from "../../../runEvents.js";
import { LedgerTakeover } from "../../../runLedger/takeover.js";
import { RunControl } from "../../../runRegistry/runControl.js";
import { createTracer } from "../../../trace/tracer.js";
import { FollowUpInbox } from "../../../threadAdmission.js";
import type { StepReport } from "../../../runLedger/stepReport.js";
import { BotHostHarnessContainer } from "../../botHostContainer.js";
import { HarnessRegistry } from "../../pi/relay.js";
import {
  openThroughSeam,
  type HarnessDeps,
  type HarnessFacts,
  type HarnessResume,
  type HarnessRun,
  type HarnessSession,
} from "../../contract.js";
import { OpenCodeHarness } from "../harness.js";
import { openCodeRunPathsAt } from "../process.js";
import { parseFeedRecord } from "../client.js";

// Feature: docs/reference/specs/harness.md item 11 (U12) — OpenCode on the
// conformance clauses against the REAL `@opencode/cli@2.0.3` binary. A run is
// driven end to end through the real `OpenCodeHarness` — the server started as
// a child of this process, the relay plugin loaded, the seed imported, the
// request prompted — with a real bot answering it (the three harness routes and
// a scripted openai-compatible model, both behind the run bearer). The
// inject-only rows (a tool that ran with no ask, a forged reply) no external
// process can produce, so they are the fake serve's (`conformance.test.ts`);
// this proves the clauses the real binary genuinely exercises — credential,
// gate, relay, record, conversation — and logs the id-join receipt: the
// `permission.asked.source.id` and the `session.tool.called.id` are the same
// call id, the key the gate's bypass detection rests on.

const BIN = resolve(import.meta.dirname, "../../../../../node_modules/.bin/opencode");
export const openCodeBinaryAvailable = (): boolean => existsSync(BIN);

const agent: AgentDef = {
  name: "real",
  description: "",
  system: "You are the real-binary conformance run.",
  toolset: "full",
  machine: "repo-resident",
  identity: "write",
  maxTurns: 50,
  maxTokens: 4096,
  maxMinutes: 5,
};

const executor: Executor = {
  exec: async (command) => `ran: ${command}`,
  readFile: async () => "",
  writeFile: async () => "",
};

/** One streamed Chat Completions answer, built by the script from what the
 *  model has seen so far: one tool call, several in one step, or the text. */
interface ModelChunks {
  toolCall(callId: string, name: string, args: unknown): unknown[];
  toolCalls(calls: Array<{ callId: string; name: string; args: unknown }>): unknown[];
  text(t: string): unknown[];
}

/** What the scripted model answers, keyed on the tool results so far. */
type ModelScript = (results: number, chunks: ModelChunks) => unknown[];

/** The scripted model, OpenAI Chat Completions streamed, keyed on the tool
 *  results so far. Records that the call carried the run bearer as its key
 *  (the credential clause). */
function answerModel(
  body: string,
  authorization: string | undefined,
  bearer: string,
  seen: { authOk: boolean },
  res: ServerResponse,
  script: ModelScript,
): void {
  if (authorization === `Bearer ${bearer}`) seen.authOk = true;
  const parsed = JSON.parse(body || "{}") as { model?: string; messages?: Array<{ role: string }> };
  const results = (parsed.messages ?? []).filter((m) => m.role === "tool").length;
  const base = {
    id: `chatcmpl-${results}`,
    object: "chat.completion.chunk" as const,
    created: Math.floor(Date.now() / 1000),
    model: parsed.model ?? "m",
  };
  const toolCalls = (calls: Array<{ callId: string; name: string; args: unknown }>) => [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: calls.map((c, index) => ({
              index,
              id: c.callId,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
          finish_reason: null,
        },
      ],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { ...base, choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
  ];
  const chunks: ModelChunks = {
    toolCalls,
    toolCall: (callId, name, args) => toolCalls([{ callId, name, args }]),
    text: (t) => [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: t }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { ...base, choices: [], usage: { prompt_tokens: 6, completion_tokens: 6, total_tokens: 12 } },
    ],
  };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const ch of script(results, chunks)) res.write(`data: ${JSON.stringify(ch)}\n\n`);
  res.end("data: [DONE]\n\n");
}

/** The conformance script: call the relayed status tool, then an allowed
 *  shell, then a push to a protected branch the gate refuses, then answer. */
const conformanceScript: ModelScript = (results, chunks) =>
  results === 0
    ? chunks.toolCall("call_status", "update_status", { checklist: "○ first step" })
    : results === 1
      ? chunks.toolCall("call_ok", "shell", { command: "echo hi" })
      : results === 2
        ? chunks.toolCall("call_push", "shell", { command: "git push origin main" })
        : chunks.text("all done from the real model");

const grantFor = (runId: string, clock: () => number): RunBearerGrant => ({
  runId,
  modelRef: "switchboard/real-model",
  providerName: "switchboard",
  providerWire: "openai-chat",
  model: "real-model",
  maxTokens: 4096,
  maxTurns: 50,
  expiresAt: clock() + 60 * 60_000,
  span: createTracer({ clock }).start("request", { sinks: [] }),
  publish: () => {},
});

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of roots.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

/** Everything a real run leaves behind for the assertions. */
interface RealRun {
  session: HarnessSession;
  events: RunEvent[];
  steps: StepReport[];
  facts: HarnessFacts[];
  statusReports: string[];
  modelSeen: { authOk: boolean };
  container: BotHostHarnessContainer;
}

/** A run driven end to end through the real `OpenCodeHarness` against the
 *  real binary, the bot's routes and the scripted model behind the run bearer;
 *  with a `resume`, the run is a rebuild from that record — the real server
 *  is handed the record as an import (harness.md item 6). */
async function driveRealRun(runId: string, script: ModelScript, resume?: HarnessResume): Promise<RealRun> {
  const clock = () => Date.now();
  const bearers = new RunBearerStore({ clock });
  const bearer = bearers.mint(grantFor(runId, clock));
  const harnesses = new HarnessRegistry();
  const takeover = new LedgerTakeover();
  takeover.settle();

  const modelSeen = { authOk: false };
  const harnessHandler = createHarnessRoutesHandler({ bearers, harnesses, takeover, log: () => {} });
  const bot = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    if (isHarnessPath(path)) return harnessHandler(req, res);
    if (path === "/v1/chat/completions") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => answerModel(body, req.headers.authorization, bearer, modelSeen, res, script));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  const botPort = await listen(bot);
  const harnessUrl = `http://127.0.0.1:${botPort}`;

  const homeDir = mkdtempSync(join(tmpdir(), "oc-real-home-"));
  roots.push(homeDir);
  const container = new BotHostHarnessContainer({
    env: { PATH: `${resolve(BIN, "..")}:${process.env.PATH ?? ""}`, HOME: homeDir },
  });

  const events: RunEvent[] = [];
  const steps: StepReport[] = [];
  const facts: HarnessFacts[] = [];
  const statusReports: string[] = [];
  const run: HarnessRun = {
    runId,
    agent,
    // The bot's provider NAME, as a live deployment's run carries it — never
    // the configuration's key: the harness must translate it, or the real
    // resolver answers `Model unavailable: anthropic/real-model`.
    model: { id: "real-model", provider: "anthropic", providerType: "openai-compatible" },
    system: agent.system,
    messages: [
      { role: "user", content: [{ type: "text", text: "earlier question" }] },
      { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
      { role: "user", content: [{ type: "text", text: "do the work" }] },
    ],
    tools: [updateStatusTool],
    toolContext: { executor, reportProgress: (list) => void statusReports.push(list) },
    rules: { checkout: homeDir, protectedBranches: ["main"] },
    control: new RunControl(),
    inbox: new FollowUpInbox(),
    onEvent: (e) => void events.push(e),
    onProgress: () => {},
    onStep: async (r) => void steps.push(r),
    saveFacts: (f) => void facts.push(f),
    ...(resume ? { resume } : {}),
  };
  const deps: HarnessDeps = {
    container,
    bearer,
    harnessUrl,
    registry: harnesses,
    bearers,
    clock,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs: 100,
    tickMs: 500,
  };

  const session = await openThroughSeam(new OpenCodeHarness(), deps, run);
  return { session, events, steps, facts, statusReports, modelSeen, container };
}

/** The run's feed, as the tailer wrote it, read whole. */
async function readFeed(run: RealRun): Promise<string> {
  const root = (run.facts[0] as { root: string }).root;
  roots.push(root);
  const feed = openCodeRunPathsAt(root).feed;
  return Buffer.from(await run.container.readLog(feed, 0, 1024 * 1024)).toString("utf8");
}

const notesOf = (events: RunEvent[]) =>
  events.filter((e): e is Extract<RunEvent, { type: "run_note" }> => e.type === "run_note");
const toolResultsOf = (events: RunEvent[]) =>
  events.filter((e): e is Extract<RunEvent, { type: "tool_result" }> => e.type === "tool_result");

describe.skipIf(!openCodeBinaryAvailable())("OpenCode against the real @opencode/cli binary", () => {
  it("drives a run end to end: the bearer is the key, the relay runs in the bot, a push to a protected branch is refused, the record speaks the vocabulary, and the id-join holds", async () => {
    const run = await driveRealRun("run-real", conformanceScript);
    const { session, events, steps, facts, statusReports, modelSeen } = run;

    // The credential clause: the model call carried the run bearer as its key.
    expect(modelSeen.authOk).toBe(true);
    // The relay clause: the relayed tool ran in the bot, its side effect landed.
    expect(statusReports).toContain("○ first step");
    // The gate clause: the push to the protected branch was refused, its
    // reason on the record; the allowed shell ran.
    const refused = events.filter(
      (e): e is Extract<RunEvent, { type: "run_note" }> => e.type === "run_note" && e.kind === "tool_refused",
    );
    expect(refused.some((n) => /main/.test(n.summary))).toBe(true);
    const toolResults = events.filter((e): e is Extract<RunEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(toolResults.some((r) => r.tool === "bash" && r.ok)).toBe(true); // echo hi ran
    expect(toolResults.some((r) => r.tool === "bash" && !r.ok)).toBe(true); // git push refused
    // The record clause's naming notes: every event the real server streamed
    // for these calls — the `shell` tool's own `shell.created`/`shell.exited`
    // among them — has a disposition that is not a `harness_error`. A kind the
    // table gets wrong shows here as its note's text (the live flood was two
    // notes per shell call).
    const harnessErrors = events.filter(
      (e): e is Extract<RunEvent, { type: "run_note" }> => e.type === "run_note" && e.kind === "harness_error",
    );
    expect(harnessErrors.map((n) => n.summary)).toEqual([]);
    // The record clause: the run's events are the record's vocabulary.
    for (const e of events)
      expect(["tool_call", "tool_result", "run_note", "assistant", "input", "lease"]).toContain(e.type);
    expect(events.some((e) => e.type === "lease")).toBe(true); // the harness started the lease (harness-pi item 15)
    // The conversation clause: the run's answer is the last step's text — the
    // row the tailer's refill delivers after `session.execution.succeeded`,
    // which the loop reads before it settles (a length check would pass on
    // `_(no response)_`); the record mirrored every step, the answer's included.
    expect(session.answer).toBe("all done from the real model");
    expect(steps.at(-1)?.turns.at(-1)?.content).toEqual([{ type: "text", text: "all done from the real model" }]);
    expect(steps.length).toBeGreaterThan(0);
    // The survival clause: the row's facts name OpenCode.
    expect(facts[0]?.harness).toBe("opencode");

    // The id-join receipt: read the feed and prove the key the gate's bypass
    // detection rests on — `permission.asked.source.id` equals the matching
    // `session.tool.called.id` — holds on the real binary.
    const feedText = await readFeed(run);
    const askSourceIds = new Set<string>();
    const calledIds = new Set<string>();
    for (const line of feedText.split("\n")) {
      const record = parseFeedRecord(line);
      if (record?.feed !== "event") continue;
      if (record.event.type === "permission.asked") {
        const id = (record.event.data as { source?: { id?: string } }).source?.id;
        if (id) askSourceIds.add(id);
      }
      if (record.event.type === "session.tool.called") {
        const id = (record.event.data as { id?: string }).id;
        if (id) calledIds.add(id);
      }
    }
    // The join the gate's bypass detection rests on: a tool call the model
    // made carries the SAME id on its `session.tool.called` and on the
    // `permission.asked` that names it (`source.id`), so the bot's reply and
    // the tool's settlement are matched by that id on the real binary.
    const joined = [...calledIds].filter((id) => askSourceIds.has(id));
    console.log(
      `[id-join receipt] session.tool.called ids=${[...calledIds].join(",")}; permission.asked.source ids=${[...askSourceIds].join(",")}; joined=${joined.join(",")}`,
    );
    expect(joined.length).toBeGreaterThan(0);

    await session.end();
  }, 120_000);

  // Feature: docs/reference/specs/harness.md item 6 (survival) — the rebuild is
  // an import the real server decodes against its session-message schema. A
  // record that holds a tool call that ran and failed and a call in flight at
  // the death authors two error tool contents; the real binary accepts them
  // (each carries the `error: { type, message }` its schema requires), lists
  // them back as its own rows, and runs the continue to its end on them.
  it("a re-attach after a failed tool call imports: the real server accepts a record holding a failed call and a call in flight, and the run continues from it", async () => {
    const resume: HarnessResume = {
      messages: [
        { role: "user", content: [{ type: "text", text: "carry on" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c-failed", name: "bash", input: { command: "make" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "c-failed", content: "make: *** [all] Error 2", isError: true }],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c-flight", name: "bash", input: { command: "make clean all" } }],
        },
      ],
      settlements: [
        {
          toolUse: { type: "tool_use", id: "c-flight", name: "bash", input: { command: "make clean all" } },
          action: "synthetic",
          text: "The container was replaced while this bash call was in flight; its result was lost.",
        },
      ],
      remainingMs: 5 * 60_000,
      turn: 2,
      inboxConsumedSeq: 0,
    };
    // Before every error tool content carried `error.type`, this open threw
    // `OpenCodeRequestRefusedError: OpenCode refused the session import (400):
    // {"_tag":"InvalidRequestError","message":"Missing key\n  at ["messages"][1]["content"][0]["state"]["error"]["type"]","kind":"Payload"}`.
    const run = await driveRealRun("run-real-rebuild", (_results, chunks) => chunks.text("carried on"), resume);
    const { session, events, steps, modelSeen } = run;
    expect(notesOf(events).filter((n) => n.kind === "harness_error")).toEqual([]);
    // The continue ran on the imported record: the model was asked under the
    // run bearer, the session's own execution ended `succeeded`, and its answer
    // — the row the refill after that event carries — is the run's, with the
    // step after the rebuild the settlement turn at the seed index, then it.
    expect(modelSeen.authOk).toBe(true);
    expect(session.answer).toBe("carried on");
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0].firstIdx).toBe(4);
    expect(steps[0].turns[0].content[0]).toEqual({
      type: "tool_result",
      toolUseId: "c-flight",
      content: "The container was replaced while this bash call was in flight; its result was lost.",
      isError: true,
    });
    const feed = (await readFeed(run))
      .split("\n")
      .map(parseFeedRecord)
      .filter((r) => r !== undefined);
    expect(feed.some((r) => r.feed === "event" && r.event.type === "session.execution.succeeded")).toBe(true);
    // The server lists the imported rows back as its own, the two failed calls
    // as error tool contents typed in its words (`Session.StructuredError`).
    const listed = feed.find((r) => r.feed === "messages" && r.data.length > 0);
    expect(listed?.feed).toBe("messages");
    const rows = listed?.feed === "messages" ? listed.data : [];
    const errorStates = rows
      .filter((m) => m.type === "assistant")
      .flatMap((m) => {
        const content = (m as { content?: unknown }).content;
        return Array.isArray(content) ? (content as unknown[]) : [];
      })
      .filter(
        (p): p is { type: "tool"; state: { status: string; error: unknown } } =>
          typeof p === "object" && p !== null && (p as { type?: unknown }).type === "tool",
      )
      .map((p) => p.state)
      .filter((s) => s.status === "error")
      .map((s) => s.error);
    expect(errorStates).toEqual([
      { type: "tool.execution", message: "make: *** [all] Error 2" },
      {
        type: "aborted",
        message: "The container was replaced while this bash call was in flight; its result was lost.",
      },
    ]);
    await session.end();
  }, 120_000);

  // Feature: docs/reference/specs/harness.md item 2 (the gate) — a step with
  // two shell calls, one the gate refuses and one it allows, on the real
  // binary. Measured: both asks are raised before either reply; the bot's
  // reject to the push makes the server decline the sibling's pending ask
  // itself (`packages/core/src/permission.ts:203-220` at v2.0.3 — the reject
  // cascade, a `permission.replied` `reject` published for it), so the bot's
  // `once` for it answers 404 (`:198-201`); the sibling fails `aborted` (`The
  // user declined this tool call`), the step fails `aborted` (`Step
  // interrupted`) and the execution ends `interrupted` — no next model call.
  it("a step with two shell calls, one refused and one allowed: the reply to the sibling meets 404 and is read as the ask withdrawn — one ask_withdrawn note, no reply-failed error, no bypass on the server's own reject echo — and the run ends by the server's own end, the sibling declined with the step", async () => {
    const twoCalls: ModelScript = (results, chunks) =>
      results === 0
        ? chunks.toolCall("call_status", "update_status", { checklist: "○ first step" })
        : results === 1
          ? chunks.toolCalls([
              { callId: "call_push", name: "shell", args: { command: "git push origin main" } },
              { callId: "call_sibling", name: "shell", args: { command: "echo sibling" } },
            ])
          : chunks.text("all done after the two-call step");
    const run = await driveRealRun("run-real-two-calls", twoCalls);
    const { session, events } = run;

    // The receipt first: what the binary did with the allowed sibling, read
    // off the record and the feed, logged whatever the assertions say.
    const notes = notesOf(events);
    const sibling = toolResultsOf(events).find((r) => r.callId === "call_sibling");
    const feedText = await readFeed(run);
    const siblingEvents: string[] = [];
    const permissionEvents: string[] = [];
    const stepEvents: string[] = [];
    let siblingRequestID: string | undefined;
    for (const line of feedText.split("\n")) {
      const record = parseFeedRecord(line);
      if (record?.feed !== "event") continue;
      const data = record.event.data as Record<string, unknown>;
      const source = data.source as { id?: string } | undefined;
      if (record.event.type === "permission.asked" && source?.id === "call_sibling") siblingRequestID = String(data.id);
      if (record.event.type.startsWith("permission."))
        permissionEvents.push(
          `${record.event.type} id=${String(data.id ?? data.requestID)} call=${String(source?.id ?? "")} reply=${String(data.reply ?? "")}`,
        );
      if (record.event.type.startsWith("session.tool.") && data.id === "call_sibling")
        siblingEvents.push(`${record.event.type} ${JSON.stringify({ executed: data.executed, error: data.error })}`);
      if (/^session\.(step|execution)\./.test(record.event.type))
        stepEvents.push(`${record.event.type}${data.error ? ` ${JSON.stringify(data.error)}` : ""}`);
    }
    console.log(
      `[two-call receipt] sibling tool_result=${JSON.stringify(sibling && { ok: sibling.ok, summary: sibling.summary })}\n  sibling feed events: ${siblingEvents.join(" | ")}\n  permission events: ${permissionEvents.join(" | ")}\n  step/execution events: ${stepEvents.join(" | ")}\n  notes: ${notes.map((n) => `${n.kind}: ${n.summary}`).join(" | ")}`,
    );

    // The refusal stands: the push was refused by the gate, on the record.
    expect(notes.some((n) => n.kind === "tool_refused" && /main/.test(n.summary))).toBe(true);
    // The sibling's reply met 404 and was read as the ask withdrawn: one note,
    // naming the sibling and the push's refusal; no reply-failed error, no
    // bypass on the server's own reject echo (`openThroughSeam` resolved).
    const withdrawn = notes.filter((n) => n.kind === "ask_withdrawn");
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0].summary).toMatch(
      /withdrew the ask for bash \(call call_sibling\) before the gate's reply \(once\) landed/,
    );
    expect(withdrawn[0].summary).toMatch(/the gate refused bash \(call call_push\) in the same step/);
    expect(notes.filter((n) => n.kind === "harness_error" && /could not be posted|bypassed/.test(n.summary))).toEqual(
      [],
    );
    // The binary's own word on the sibling: declined with the step, never run —
    // its `permission.replied` `reject` the server's, its failure `aborted`.
    expect(siblingRequestID).toBeDefined();
    expect(permissionEvents).toContain(`permission.replied id=${siblingRequestID} call= reply=reject`);
    expect(siblingEvents.some((e) => /^session\.tool\.failed .*"aborted"/.test(e))).toBe(true);
    expect(siblingEvents.some((e) => e.startsWith("session.tool.success"))).toBe(false);
    expect(sibling).toMatchObject({ ok: false });
    // The step with the declined call ended the execution `interrupted`: the
    // run ended by the server's own end, with no further model call.
    expect(stepEvents.at(-1)).toBe("session.execution.interrupted");

    await session.end();
  }, 120_000);
});
