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

/** The subset of the OpenAI Chat Completions request the script reads. */
export interface ChatRequest {
  model?: string;
  messages: ReadonlyArray<{ role: string; content?: unknown; tool_call_id?: string }>;
  tools?: ReadonlyArray<{ type: string; function: { name: string } }>;
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
  if (done < script.length) return script[done];
  const last = script[script.length - 1];
  return last && last.kind === "text" ? last : DEFAULT_FINAL;
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
