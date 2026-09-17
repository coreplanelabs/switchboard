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
import { openThroughSeam, type HarnessDeps, type HarnessFacts, type HarnessRun } from "../../contract.js";
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

const RUN_ID = "run-real";

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

/** The scripted model, OpenAI Chat Completions streamed, keyed on the tool
 *  results so far: call the relayed status tool, then an allowed shell, then a
 *  push to a protected branch the gate refuses, then answer. Records that the
 *  call carried the run bearer as its key (the credential clause). */
function answerModel(
  body: string,
  authorization: string | undefined,
  bearer: string,
  seen: { authOk: boolean },
  res: ServerResponse,
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
  const toolCall = (callId: string, name: string, args: unknown) => [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: [
              { index: 0, id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { ...base, choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
  ];
  const text = (t: string) => [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: t }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { ...base, choices: [], usage: { prompt_tokens: 6, completion_tokens: 6, total_tokens: 12 } },
  ];
  const chunks =
    results === 0
      ? toolCall("call_status", "update_status", { checklist: "○ first step" })
      : results === 1
        ? toolCall("call_ok", "shell", { command: "echo hi" })
        : results === 2
          ? toolCall("call_push", "shell", { command: "git push origin main" })
          : text("all done from the real model");
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const ch of chunks) res.write(`data: ${JSON.stringify(ch)}\n\n`);
  res.end("data: [DONE]\n\n");
}

const grantFor = (runId: string, clock: () => number): RunBearerGrant => ({
  runId,
  modelRef: "switchboard/real-model",
  providerName: "switchboard",
  providerType: "openai-compatible",
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

describe.skipIf(!openCodeBinaryAvailable())("OpenCode against the real @opencode/cli binary", () => {
  it("drives a run end to end: the bearer is the key, the relay runs in the bot, a push to a protected branch is refused, the record speaks the vocabulary, and the id-join holds", async () => {
    const clock = () => Date.now();
    const bearers = new RunBearerStore({ clock });
    const bearer = bearers.mint(grantFor(RUN_ID, clock));
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
        req.on("end", () => answerModel(body, req.headers.authorization, bearer, modelSeen, res));
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
      runId: RUN_ID,
      agent,
      model: { id: "real-model", provider: "switchboard", providerType: "openai-compatible" },
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
    // The record clause: the run's events are the record's vocabulary.
    for (const e of events)
      expect(["tool_call", "tool_result", "run_note", "assistant", "input", "lease"]).toContain(e.type);
    expect(events.some((e) => e.type === "lease")).toBe(true); // the harness started the lease (harness-pi item 15)
    // The conversation clause: the run answered; the record mirrored steps.
    expect(session.answer.length).toBeGreaterThan(0);
    expect(steps.length).toBeGreaterThan(0);
    // The survival clause: the row's facts name OpenCode.
    expect(facts[0]?.harness).toBe("opencode");

    // The id-join receipt: read the feed and prove the key the gate's bypass
    // detection rests on — `permission.asked.source.id` equals the matching
    // `session.tool.called.id` — holds on the real binary.
    const root = (facts[0] as { root: string }).root;
    roots.push(root);
    const feed = openCodeRunPathsAt(root).feed;
    const feedText = Buffer.from(await container.readLog(feed, 0, 1024 * 1024)).toString("utf8");
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
});
