import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDef } from "../../../../agents/registry.js";
import type { Executor } from "../../../../execution/executor.js";
import { updateStatusTool } from "../../../../tools/status.js";
import { createHarnessRoutesHandler, isHarnessPath } from "../../../../channels/harnessRoutes.js";
import { createModelProxyHandler, isModelProxyPath } from "../../../../channels/modelProxy.js";
import { secretsFrom } from "../../../../secrets.js";
import type { ModelCard } from "../../../modelCard.js";
import type { ProviderConfig } from "../../../provider.js";
import type { SpanRecord } from "../../../trace/types.js";
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
  tiers: ["strong"],
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
  const chunks = scriptedChunks(parsed, script);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const ch of chunks) res.write(`data: ${JSON.stringify(ch)}\n\n`);
  res.end("data: [DONE]\n\n");
}

/** The scripted answer's chunks for one captured request body — shared by the
 *  direct fake model and the proxied logging fake's upstream. */
function scriptedChunks(
  parsed: { model?: string; messages?: Array<{ role: string }> },
  script: ModelScript,
): unknown[] {
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
  return script(results, chunks);
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

const grantFor = (
  runId: string,
  clock: () => number,
  spans: SpanRecord[],
  over: Partial<RunBearerGrant> = {},
): RunBearerGrant => ({
  runId,
  modelRef: "switchboard/real-model",
  providerName: "switchboard",
  providerWire: "openai-chat",
  model: "real-model",
  maxTokens: 4096,
  maxTurns: 50,
  expiresAt: clock() + 60 * 60_000,
  span: createTracer({ clock }).start("request", { sinks: [{ onEnd: (r) => void spans.push(r) }] }),
  publish: () => {},
  ...over,
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

async function listen(server: Server, port = 0): Promise<number> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
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
  modelSeen: { authOk: boolean; bodies: Array<Record<string, unknown>> };
  /** The bodies the upstream saw when the run went through the real proxy. */
  upstreamBodies: Array<Record<string, unknown>>;
  /** Every span the grant's tracer ended — the proxy's `model.turn` meter rows among them. */
  spans: SpanRecord[];
  container: BotHostHarnessContainer;
  /** The bot generation this run answered from: closed and re-listened on the same port for a roll. */
  botServer: Server;
  botPort: number;
  homeDir: string;
}

/** How a run is steered off the default hand-built spec: the run's card and
 *  effort, its model, and — for the aggregator measurement — the REAL model
 *  proxy mounted in the bot with a logging fake upstream behind it. */
interface RealRunOptions {
  model?: HarnessRun["model"];
  card?: ModelCard;
  effort?: NonNullable<HarnessRun["effort"]>;
  grant?: Partial<RunBearerGrant>;
  proxy?: { providers: Record<string, ProviderConfig>; env: Record<string, string> };
  /** A bot roll: this generation's bot is fresh (new stores, new handlers) but
   *  listens on the DEAD generation's port, in the same container and home —
   *  the live OpenCode server's relay and model URLs keep resolving. The caller
   *  closes the dead generation's server first. */
  roll?: { container: BotHostHarnessContainer; homeDir: string; botPort: number };
}

/** A run driven end to end through the real `OpenCodeHarness` against the
 *  real binary, the bot's routes and the scripted model behind the run bearer;
 *  with a `resume`, the run is a rebuild from that record — the real server
 *  is handed the record as an import (harness.md item 6). */
async function driveRealRun(
  runId: string,
  script: ModelScript,
  resume?: HarnessResume,
  opts?: RealRunOptions,
): Promise<RealRun> {
  const clock = () => Date.now();
  const bearers = new RunBearerStore({ clock });
  const spans: SpanRecord[] = [];
  const bearer = bearers.mint(grantFor(runId, clock, spans, opts?.grant));
  const harnesses = new HarnessRegistry();
  const takeover = new LedgerTakeover();
  takeover.settle();

  const modelSeen = { authOk: false, bodies: [] as Array<Record<string, unknown>> };
  // The logging fake upstream behind the real proxy: it records every body the
  // provider would see and answers the same script, the usage frame reporting
  // cached prompt tokens from the second turn on — what a warm aggregator
  // cache reports once the markers ride.
  const upstreamBodies: Array<Record<string, unknown>> = [];
  const upstreamFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { model?: string; messages?: Array<{ role: string }> };
    upstreamBodies.push(parsed as Record<string, unknown>);
    const results = (parsed.messages ?? []).filter((m) => m.role === "tool").length;
    const chunks = scriptedChunks(parsed, script).map((c) => {
      const usage = (c as { usage?: Record<string, unknown> }).usage;
      return usage
        ? { ...(c as object), usage: { ...usage, prompt_tokens_details: { cached_tokens: results > 0 ? 777 : 0 } } }
        : c;
    });
    const sse = chunks.map((ch) => `data: ${JSON.stringify(ch)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const proxyHandler = opts?.proxy
    ? createModelProxyHandler({
        bearers,
        providers: () => opts.proxy!.providers,
        secrets: secretsFrom(opts.proxy.env),
        clock,
        fetch: upstreamFetch,
      })
    : undefined;
  const harnessHandler = createHarnessRoutesHandler({ bearers, harnesses, takeover, log: () => {} });
  const bot = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    if (isHarnessPath(path)) return harnessHandler(req, res);
    if (proxyHandler && isModelProxyPath(path)) return proxyHandler(req, res);
    if (path === "/v1/chat/completions") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        modelSeen.bodies.push(JSON.parse(body || "{}") as Record<string, unknown>);
        answerModel(body, req.headers.authorization, bearer, modelSeen, res, script);
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  const botPort = await listen(bot, opts?.roll?.botPort ?? 0);
  const harnessUrl = `http://127.0.0.1:${botPort}`;

  const homeDir = opts?.roll?.homeDir ?? mkdtempSync(join(tmpdir(), "oc-real-home-"));
  if (opts?.roll === undefined) roots.push(homeDir);
  const container =
    opts?.roll?.container ??
    new BotHostHarnessContainer({
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
    model: opts?.model ?? { id: "real-model", provider: "anthropic", providerType: "openai-compatible" },
    ...(opts?.card ? { card: opts.card } : {}),
    ...(opts?.effort ? { effort: opts.effort } : {}),
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
  return {
    session,
    events,
    steps,
    facts,
    statusReports,
    modelSeen,
    upstreamBodies,
    spans,
    container,
    botServer: bot,
    botPort,
    homeDir,
  };
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

  // Feature: docs/reference/specs/harness.md item 6 (survival) — a bot roll
  // under a live process re-attaches in place, no rebuild, on the real binary:
  // the new generation — fresh stores and handlers on the dead generation's
  // port — finds the row's server alive, reads its session's store back through
  // the messages route, and continues the same server and session instead of
  // ending it and rebuilding from the record.
  it("a bot roll under a live process re-attaches in place, no rebuild: the new generation continues the same server and session, and the run answers", async () => {
    const first = await driveRealRun("run-real-roll", (_r, chunks) => chunks.text("first answer"));
    expect(first.session.answer).toBe("first answer");
    const rowFacts = first.facts.at(-1)!;
    roots.push((rowFacts as { root: string }).root);
    // The roll: the dead generation's bot closes; the server and its tailer live on.
    await new Promise<void>((r) => first.botServer.close(() => r()));
    const resume: HarnessResume = {
      messages: [
        { role: "user", content: [{ type: "text", text: "earlier question" }] },
        { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
        { role: "user", content: [{ type: "text", text: "do the work" }] },
        ...first.steps.flatMap((s) => s.turns),
      ],
      settlements: [],
      remainingMs: 5 * 60_000,
      turn: 2,
      inboxConsumedSeq: 0,
      facts: rowFacts,
    };
    const second = await driveRealRun("run-real-roll", (_r, chunks) => chunks.text("rolled on"), resume, {
      roll: { container: first.container, homeDir: first.homeDir, botPort: first.botPort },
    });
    expect(notesOf(second.events).filter((n) => n.kind === "harness_error")).toEqual([]);
    const resumed = notesOf(second.events).filter((n) => n.kind === "resumed");
    expect(resumed).toHaveLength(1);
    expect(resumed[0].summary).toMatch(
      /^resumed after a restart: OpenCode still runs in the container \(pid \d+, port \d+\); continuing its session/,
    );
    // In place, no rebuild: the row's pid, port, root and session are this run's too.
    const after = second.facts.at(-1)! as unknown as Record<string, unknown>;
    const row = rowFacts as unknown as Record<string, unknown>;
    for (const key of ["pid", "port", "root", "sessionID"]) expect(after[key]).toBe(row[key]);
    expect(second.session.answer).toBe("rolled on");
    await second.session.end();
  }, 240_000);

  // Feature: docs/reference/specs/harness.md item 2 (the gate) — a step with
  // two shell calls, one the gate refuses and one it allows, on the real
  // binary. Measured: both asks are raised before either reply; the bot's
  // reject to the push makes the server decline the sibling's pending ask
  // itself (`packages/core/src/permission.ts:203-220` at v2.0.3 — the reject
  // cascade, a `permission.replied` `reject` published for it), so the bot's
  // `once` for it answers 404 (`:198-201`); the sibling fails `aborted` (`The
  // user declined this tool call`), the step fails `aborted` (`Step
  // interrupted`) and the execution ends `interrupted`. The loop then
  // re-prompts the model with the refusal (harness.md item 2): a new
  // execution starts, the model continues, and its text is the run's answer.
  it("a step with two shell calls, one refused and one allowed: the reply to the sibling meets 404 and is read as the ask withdrawn — one ask_withdrawn note, no reply-failed error, no bypass on the server's own reject echo — and the loop re-prompts the model with the refusal (a decline_cascade note), so the next step runs and its text is the run's answer", async () => {
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
    // The step with the declined call ended its execution `interrupted` — the
    // server's own end after the cascade — and the loop re-prompted the model
    // with the refusal: a new execution started and succeeded, its text the
    // run's answer, the re-prompt on the record as a `decline_cascade` note.
    const interruptedAt = stepEvents.indexOf("session.execution.interrupted");
    expect(interruptedAt).toBeGreaterThan(-1);
    expect(stepEvents.slice(interruptedAt + 1)).toContain("session.execution.started");
    expect(stepEvents.at(-1)).toBe("session.execution.succeeded");
    expect(notes.some((n) => n.kind === "decline_cascade")).toBe(true);
    expect(session.answer).toBe("all done after the two-call step");

    await session.end();
  }, 120_000);
});

// Feature: docs/reference/specs/model-proxy.md item 11 — the harness write
// names the biller's own provider (record 0052's amendment, U44). A run on an
// aggregator block goes through the REAL model proxy to a logging fake
// upstream: the binary's own aggregator provider (`@openrouter/ai-sdk-provider`)
// asks for the final chunk's usage (`usage: { include: true }`, the cost the
// meter reads) and spells reasoning its own way (`reasoning: { effort }`), and
// the proxy's meter row shows the cache read the upstream reports from the
// second turn on. The cache markers ride the aggregator's own way: the pinned
// binary places NO per-block `cache_control` breakpoints on the openrouter
// route — it exempts that route from its automatic placement and no
// configuration key reaches the request's own `cache` option — so the write
// carries OpenRouter's other documented spelling, one top-level
// `cache_control: { type: "ephemeral" }` (its "automatic caching", honoured on
// its Anthropic-family routes), as the provider's `settings.extraBody`, which
// the binary merges into every request body (a model-level `options` entry
// does NOT reach the body — measured). The same script on
// the generic package (the plain run) carries neither the usage ask nor the
// reasoning object — asserted against the direct fake's captured bodies.
describe.skipIf(!openCodeBinaryAvailable())("OpenCode speaks the aggregator's own protocol through the proxy", () => {
  /** The aggregator card the dispatcher would resolve for the block (record
   *  0052): markers from the vendor, the levels named through high. */
  const aggregatorCard: ModelCard = {
    ref: "openrouter/anthropic/claude-sonnet-4",
    block: "openrouter",
    model: "anthropic/claude-sonnet-4",
    vendor: "anthropic",
    wire: "openai-chat",
    levels: {
      low: { word: "low", named: true },
      medium: { word: "medium", named: true },
      high: { word: "high", named: true },
      xhigh: { word: "high", named: false },
      max: "refused",
    },
    capField: "max_tokens",
    window: 200_000,
    inputs: { image: true, document: "unknown" },
    cache: "markers",
    provenance: {
      levels: "registry",
      capField: "registry",
      window: "registry",
      inputs: "registry",
      cache: "wire",
      price: "wire",
    },
  };

  const markerSpots = (body: Record<string, unknown>) => {
    const carries = (v: unknown): boolean => JSON.stringify(v)?.includes('"cache_control"') ?? false;
    const tools = (body.tools as Array<Record<string, unknown>> | undefined) ?? [];
    const messages = (body.messages as Array<{ role: string; content: unknown }> | undefined) ?? [];
    const system = messages.filter((m) => m.role === "system" || m.role === "developer");
    return {
      lastTool: tools.length > 0 && carries(tools.at(-1)),
      system: system.some((m) => carries(m.content)),
      tail: messages.length > 0 && carries(messages.at(-1)),
      anywhere: carries(body),
    };
  };

  it("an aggregator run's captured payload asks for usage, spells reasoning the aggregator's way and carries the top-level cache_control on every turn — per-block markers stay absent, the binary's measured behaviour — and the meter row shows the cache read the upstream reports on the second turn", async () => {
    const script: ModelScript = (results, chunks) =>
      results === 0
        ? chunks.toolCall("call_status", "update_status", { checklist: "○ first step" })
        : chunks.text("cached and done");
    const run = await driveRealRun("run-real-aggregator", script, undefined, {
      model: { id: "anthropic/claude-sonnet-4", provider: "openrouter", providerType: "openai-compatible" },
      card: aggregatorCard,
      effort: "high",
      grant: {
        modelRef: "openrouter/anthropic/claude-sonnet-4",
        providerName: "openrouter",
        providerWire: "openai-chat",
        model: "anthropic/claude-sonnet-4",
      },
      proxy: {
        providers: {
          openrouter: {
            type: "openai-compatible",
            wire: "openai-chat",
            vendor: "model",
            catalog: "openrouter",
            baseUrl: "http://upstream.test/v1",
            apiKeyEnv: "OPENROUTER_API_KEY",
          },
        },
        env: { OPENROUTER_API_KEY: "sk-or-fake" },
      },
    });
    const { session, upstreamBodies, spans, statusReports } = run;

    // The run went end to end through the proxy: the relayed tool ran, the
    // answer is the script's.
    expect(statusReports).toContain("○ first step");
    expect(session.answer).toBe("cached and done");
    expect(upstreamBodies.length).toBeGreaterThanOrEqual(2);

    // The measurement's receipt: where the binary put the markers, verbatim.
    const spots = upstreamBodies.map(markerSpots);
    console.log(
      `[aggregator payload receipt] ${upstreamBodies
        .map(
          (b, i) =>
            `turn ${i}: usage=${JSON.stringify(b.usage)} reasoning=${JSON.stringify(b.reasoning)} markers=${JSON.stringify(spots[i])}`,
        )
        .join("; ")}`,
    );

    for (const [i, body] of upstreamBodies.entries()) {
      // The aggregator protocol asks for the final chunk's usage (its cost
      // rides it) and spells the tier its own way — `reasoning.effort`, never
      // `reasoning_effort`.
      expect(body.usage, `turn ${i}`).toEqual({ include: true });
      expect(body.reasoning, `turn ${i}`).toEqual({ effort: "high" });
      expect(body).not.toHaveProperty("reasoning_effort");
      // The markers, the aggregator's own way: the provider's
      // `settings.extraBody` rides every request body as OpenRouter's
      // top-level `cache_control: { type: "ephemeral" }` ("automatic
      // caching"). The measured negative stays measured: the pinned binary
      // exempts the openrouter route from per-block placement, so the last
      // tool, the system part and the tail carry none.
      expect(body.cache_control, `turn ${i}`).toEqual({ type: "ephemeral" });
      expect(spots[i], `turn ${i}`).toMatchObject({ lastTool: false, system: false, tail: false });
    }

    // The meter's word (model-proxy item 3): the upstream reported cached
    // prompt tokens from the second turn on, and the proxy's `model.turn` rows
    // carry them as `cacheReadTokens` — what the run page and the analytics
    // tie-out read.
    const turns = spans.filter((s) => s.name === "model.turn");
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns[0]!.attrs.cacheReadTokens ?? 0).toBe(0);
    expect(turns.at(-1)!.attrs.cacheReadTokens).toBe(777);

    await session.end();
  }, 120_000);

  it("the generic package places no markers and asks for no usage: the plain run's captured bodies carry neither", async () => {
    const run = await driveRealRun("run-real-generic-contrast", (results, chunks) =>
      results === 0 ? chunks.toolCall("call_status", "update_status", { checklist: "○ one step" }) : chunks.text("ok"),
    );
    const { session, modelSeen } = run;
    expect(session.answer).toBe("ok");
    expect(modelSeen.bodies.length).toBeGreaterThanOrEqual(2);
    for (const body of modelSeen.bodies) {
      expect(markerSpots(body).anywhere).toBe(false);
      expect(body).not.toHaveProperty("usage");
      expect(body).not.toHaveProperty("reasoning");
    }
    await session.end();
  }, 120_000);
});
