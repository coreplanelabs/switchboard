// A model that never thinks: an OpenAI-compatible Chat Completions server the
// existing `openaiCompat` provider can point at (config: `type:
// openai-compatible`, `baseUrl: http://127.0.0.1:<port>`). It answers from a
// fixed script, a state machine keyed on how many tool results the
// conversation already carries — so one server serves fifty conversations at
// once with no per-conversation state, and `load:e2e` measures the bot, the
// resident and the sandbox, never the model. The default profiles end with a
// plain text answer and NO terminal tool (`submit_pr_description`,
// `submit_verdict`), so a load run has no GitHub side effect; `terminal: true`
// opts in for a fixture repo.

import { createServer, type Server } from "node:http";

export type Step =
  { kind: "tool"; name: string; input: Record<string, unknown>; text?: string } | { kind: "text"; text: string };

export type Script = readonly Step[];

/** The subset of the OpenAI Chat Completions request the script reads.
 *  `stream: true` (pi's client always sets it) selects the chunked answer. */
export interface ChatRequest {
  model?: string;
  messages: ReadonlyArray<{ role: string; content?: unknown; tool_call_id?: string }>;
  tools?: ReadonlyArray<{ type: string; function: { name: string } }>;
  stream?: boolean;
}

/** One server-sent chunk of a streamed completion: the same step as
 *  `chatCompletion` answers, split the way OpenAI's streaming clients (pi's
 *  among them) reassemble it — the whole call in one delta, then the finish
 *  reason, then a usage-only chunk with no choices. */
export interface ChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: Array<{
        index: 0;
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: "tool_calls" | "stop" | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    };
    finish_reason: "tool_calls" | "stop";
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const DEFAULT_FINAL: Step = { kind: "text", text: "Done." };

/** The step for this conversation: the count of tool results already in it.
 *  Past the script's end the answer is its trailing text step, or `Done.`. */
export function nextStep(script: Script, messages: ChatRequest["messages"]): Step {
  const done = messages.filter((m) => m.role === "tool").length;
  if (done < script.length) return resolveStep(script[done], messages);
  const last = script[script.length - 1];
  return last && last.kind === "text" ? last : DEFAULT_FINAL;
}

/** The one value a script cannot know when it is written: the head a review
 *  must name. The pi review profile's verdict carries this in `head`, and the
 *  step is resolved against the request — the way a model reads the head off
 *  the REVIEW TARGET block. A request without the block leaves the token,
 *  which the verdict parser drops as a malformed head. */
export const REVIEW_HEAD_PLACEHOLDER = "<the head commit named in the REVIEW TARGET block>";
const REVIEW_TARGET_HEAD = /Head commit: ([0-9a-f]{40})\b/;

function resolveStep(step: Step, messages: ChatRequest["messages"]): Step {
  if (step.kind !== "tool" || step.input.head !== REVIEW_HEAD_PLACEHOLDER) return step;
  for (const m of messages) {
    if (typeof m.content !== "string") continue;
    const head = REVIEW_TARGET_HEAD.exec(m.content)?.[1];
    if (head) return { ...step, input: { ...step.input, head } };
  }
  return step;
}

export function chatCompletion(req: ChatRequest, script: Script, now: () => number = Date.now): ChatResponse {
  const declared = req.tools ? new Set(req.tools.map((t) => t.function.name)) : undefined;
  // A tool the agent's toolset does not declare cannot be called: it is
  // removed from the script for this request, so the step index stays the
  // count of tool results and every declared tool is called exactly once — a
  // profile written for the coding toolset still ends a review run.
  const effective = declared ? script.filter((s) => s.kind === "text" || declared.has(s.name)) : script;
  const index = req.messages.filter((m) => m.role === "tool").length;
  const step = nextStep(effective, req.messages);
  const promptTokens = Math.max(1, Math.round(JSON.stringify(req.messages).length / 4));
  const base = {
    id: `scripted-${index}`,
    object: "chat.completion" as const,
    created: Math.floor(now() / 1000),
    model: req.model ?? "scripted",
  };
  if (step.kind === "text") {
    return {
      ...base,
      choices: [{ index: 0, message: { role: "assistant", content: step.text }, finish_reason: "stop" }],
      usage: usage(promptTokens, step.text.length),
    };
  }
  const args = JSON.stringify(step.input);
  return {
    ...base,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: step.text ?? null,
          tool_calls: [{ id: `call_${index}`, type: "function", function: { name: step.name, arguments: args } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: usage(promptTokens, args.length),
  };
}

function usage(prompt: number, completionChars: number) {
  const completion = Math.max(1, Math.round(completionChars / 4));
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/** The streamed form of `chatCompletion`: the same step, as the chunks a
 *  `stream: true` request receives. */
export function chatCompletionChunks(req: ChatRequest, script: Script, now: () => number = Date.now): ChatChunk[] {
  const whole = chatCompletion(req, script, now);
  const base = { id: whole.id, object: "chat.completion.chunk" as const, created: whole.created, model: whole.model };
  const choice = whole.choices[0];
  const first: ChatChunk["choices"][number] =
    choice.finish_reason === "tool_calls"
      ? {
          index: 0,
          delta: {
            role: "assistant",
            content: choice.message.content,
            tool_calls: (choice.message.tool_calls ?? []).map((call) => ({ index: 0 as const, ...call })),
          },
          finish_reason: null,
        }
      : { index: 0, delta: { role: "assistant", content: choice.message.content ?? "" }, finish_reason: null };
  return [
    { ...base, choices: [first] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] },
    { ...base, choices: [], usage: whole.usage },
  ];
}

export interface ProfileOptions {
  /** How long the CPU-burning step runs. */
  cpuSeconds: number;
  /** End with the agent's terminal tool (posts to GitHub) — only for a fixture repo. */
  terminal?: boolean;
}

/** The busy loop: pure CPU for `seconds`, one core, no I/O — the shape of a
 *  test run's cost without needing the repo's own test command. */
export function cpuBurnCommand(seconds: number): string {
  return `node -e 'const e=Date.now()+${seconds}*1000;let x=0;while(Date.now()<e){x=(x*31+1)%1000003}console.log("burn",${seconds},"s",x)'`;
}

export const HARNESS_DIR = ".load-harness";

/** A coding run's tool mix: read, look around, burn CPU, write inside the
 *  worktree, answer. No push, no PR. */
export function codingProfileScript(opts: ProfileOptions): Script {
  const script: Step[] = [
    { kind: "tool", name: "read_file", input: { path: "README.md" } },
    { kind: "tool", name: "bash", input: { command: "git status --short | head -20" } },
    {
      kind: "tool",
      name: "bash",
      input: { command: cpuBurnCommand(opts.cpuSeconds) },
      text: "Running the test-shaped step.",
    },
    {
      kind: "tool",
      name: "write_file",
      input: { path: `${HARNESS_DIR}/note.txt`, content: "load harness was here\n" },
    },
  ];
  if (opts.terminal) {
    script.push({
      kind: "tool",
      name: "submit_pr_description",
      input: { tldr: "Load harness run.", whatAndWhy: "Synthetic.", decisions: "None.", validation: "None." },
    });
  }
  script.push({ kind: "text", text: "Load harness run complete: read, inspected, burned CPU, wrote a note." });
  return script;
}

/** A review run's tool mix: read, diff, burn CPU, answer — `submit_verdict`
 *  only when `terminal` is set, because it posts to the PR. */
export function reviewProfileScript(opts: ProfileOptions): Script {
  const script: Step[] = [
    { kind: "tool", name: "read_file", input: { path: "README.md" } },
    { kind: "tool", name: "bash", input: { command: "git log --oneline -5" } },
    {
      kind: "tool",
      name: "bash",
      input: { command: cpuBurnCommand(opts.cpuSeconds) },
      text: "Running the test-shaped step.",
    },
  ];
  if (opts.terminal) {
    script.push({
      kind: "tool",
      name: "submit_verdict",
      input: {
        verdict: "approve",
        summary: "Load harness run — synthetic approval on a fixture PR.",
        head: "HEAD",
        findings: [],
      },
    });
  }
  script.push({ kind: "text", text: "Load harness review complete." });
  return script;
}

/** A description that passes `parsePrDescription`, for the pi profile: the
 *  scripted model's one PR-shaped artifact. */
export const SCRIPTED_PR_DESCRIPTION = {
  title: "Load harness note",
  tldr: "Adds a note file under the harness directory.",
  why: "A synthetic change so the harness can prove the PR-shaped path end to end without a model.",
  pointers: [
    {
      label: "The note",
      text: "One line written by the scripted model.",
      anchor: { path: `${HARNESS_DIR}/note.txt`, from: 1, to: 1 },
    },
  ],
  feedbackWanted: "Nothing: the content is synthetic.",
  risk: "None: the file lives under the harness directory.",
  verified: "The scripted model reads the note back.",
  decisions: [{ title: "Synthetic content", rationale: "The harness measures plumbing, not prose." }],
  validation: { criteria: [{ criterion: "The note exists", proof: `cat ${HARNESS_DIR}/note.txt` }] },
};

/** The coding profile in pi's tool vocabulary (`read`, `bash`, `write`
 *  instead of `read_file`, `bash`, `write_file`), for `load:pi`'s dry run.
 *  It always ends by submitting the description: with pi the terminal tool
 *  only reaches the driver, never GitHub, so there is no side effect to opt
 *  out of. */
export function piCodingProfileScript(opts: ProfileOptions): Script {
  return [
    { kind: "tool", name: "read", input: { path: "README.md" } },
    { kind: "tool", name: "bash", input: { command: "git status --short | head -20" } },
    {
      kind: "tool",
      name: "bash",
      input: { command: cpuBurnCommand(opts.cpuSeconds) },
      text: "Running the test-shaped step.",
    },
    { kind: "tool", name: "write", input: { path: `${HARNESS_DIR}/note.txt`, content: "load harness was here\n" } },
    { kind: "tool", name: "submit_pr_description", input: SCRIPTED_PR_DESCRIPTION },
    {
      kind: "text",
      text: "Load harness run complete: read, inspected, burned CPU, wrote a note, submitted the description.",
    },
  ];
}

/** The review profile in pi's tool vocabulary, for `load:pi --suite review`'s
 *  dry run: the head and the diff read with pi's `bash`, then a verdict in
 *  the house shape — `approve`, a summary, one nit, and the reviewed head
 *  resolved from the request (`REVIEW_HEAD_PLACEHOLDER`) — then text. No
 *  `read`, `edit` or `write`: a review reads with git, and a read run holds
 *  no write tool. */
export function piReviewProfileScript(opts: ProfileOptions): Script {
  return [
    { kind: "tool", name: "bash", input: { command: "git rev-parse HEAD && git diff --stat origin/main...HEAD" } },
    {
      kind: "tool",
      name: "bash",
      input: { command: cpuBurnCommand(opts.cpuSeconds) },
      text: "Reading the change.",
    },
    {
      kind: "tool",
      name: "submit_verdict",
      input: {
        verdict: "approve",
        summary: "Load harness review — synthetic approval of the pinned head.",
        head: REVIEW_HEAD_PLACEHOLDER,
        findings: [{ id: "F1", severity: "nit", file: "README.md", title: "A synthetic nit from the scripted model" }],
      },
    },
    { kind: "text", text: "Load harness review complete: read the head and the diff, submitted the verdict." },
  ];
}

/** A replay fixture of a coding child whose base moved into conflict during
 *  its round (record 0071 mechanism one; agent-coding item 13): the child
 *  reads and resolves the conflicted coordinator in the same bounded round,
 *  continues the rebase, re-runs the gates and only then pushes. Replayed by
 *  its unit test alone; it is wired into no load suite because its last step
 *  is a real push. */
export function rebaseBeforePushScript(opts: ProfileOptions): Script {
  return [
    {
      kind: "tool",
      name: "write_file",
      input: { path: `${HARNESS_DIR}/note.txt`, content: "the unit's change\n" },
      text: "Implementing the unit's change.",
    },
    {
      kind: "tool",
      name: "bash",
      input: { command: "git fetch origin main" },
      text: "Immediately before the push: fetching the base branch — it moved during the round.",
    },
    {
      kind: "tool",
      name: "bash",
      input: { command: "git rebase origin/main" },
      text: "The rebase reports a conflict in src/core/ship/coordinator.ts.",
    },
    {
      kind: "tool",
      name: "read_file",
      input: { path: "src/core/ship/coordinator.ts" },
      text: "Reading the conflicted coordinator with the unit's context still in this round.",
    },
    {
      kind: "tool",
      name: "write_file",
      input: {
        path: "src/core/ship/coordinator.ts",
        content: "// fixture: the bounded round reconciled the base ending with the unit ending\n",
      },
      text: "Resolving the coordinator conflict with the base and unit requirements together.",
    },
    {
      kind: "tool",
      name: "bash",
      input: { command: "git add src/core/ship/coordinator.ts && GIT_EDITOR=true git rebase --continue" },
      text: "Continuing the resolved rebase inside the same bounded round.",
    },
    {
      kind: "tool",
      name: "bash",
      input: { command: cpuBurnCommand(opts.cpuSeconds) },
      text: "Re-running the fast gates on the rebased tree.",
    },
    {
      kind: "tool",
      name: "bash",
      input: { command: "git push --force-with-lease -u origin HEAD" },
      text: "The gates passed on the rebased tree: pushing.",
    },
    { kind: "text", text: "Pushed after the pre-push rebase: fetch, rebase, gates, push — in that order." },
  ];
}

export interface ScriptedProviderServer {
  url: string;
  port: number;
  /** Requests served so far (any path). */
  readonly requests: number;
  close(): Promise<void>;
}

/** Serve `POST /chat/completions` from the script on `port` (0 = ephemeral). */
export function startScriptedProvider(
  script: Script,
  opts: { port?: number; host?: string } = {},
): Promise<ScriptedProviderServer> {
  const host = opts.host ?? "127.0.0.1";
  let requests = 0;
  const server: Server = createServer((req, res) => {
    requests++;
    if (req.method !== "POST" || req.url !== "/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: ChatRequest;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        for (const chunk of chatCompletionChunks(body, script)) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      const answer = chatCompletion(body, script);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://${host}:${port}`,
        port,
        get requests() {
          return requests;
        },
        close: () =>
          new Promise<void>((done, fail) => {
            server.closeAllConnections?.();
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}
