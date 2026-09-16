// The OpenCode plugin a run's container loads (docs/reference/specs/harness.md
// item 3; the relay clause), the sibling of pi's `extensionSource.ts`, as the
// text the harness writes into the run's plugin directory before `opencode
// serve` starts. Plain JavaScript that imports nothing: OpenCode's own loader
// runs the directory's `index.js` as written, with no `bun install` and no
// package (proven against `@opencode/cli@2.0.3`: a configured plugin directory
// loads and `POST /api/plugin/await-activation` settles it). It does one
// thing. At load it fetches the run's relayed tools from `GET /harness/tools`
// and registers each through the v2 `tool.transform` editor with its JSON
// Schema — registered as a DIRECT tool (`options.codemode: false`) so the
// model calls it by its own name, not through CodeMode's meta-tool (an
// omitted `codemode` makes the tool reachable only inside `execute`, and a
// direct call then answers "No tool named …"). Each call runs `POST
// /harness/authorize` then `POST /harness/tool` with the model's call id
// (`context.id`), honouring a `202 pending` by re-asking under the same id and
// the 90-second waits exactly as pi's extension does, so the relay's
// idempotency by the caller's call id holds and the bot gains no MCP endpoint.
//
// The gate on OpenCode's OWN tools (shell, read, edit, …) does NOT ride this
// plugin: it rides the server's `permission.asked`, decided in the bridge
// (the gate is the bot's decision). The plugin's `execute.before` hook is registered only as the seam
// the harness watches; its failure channel is a `Tool.Error` that the types
// say blocks the call, but the gate never depends on it.
//
// The bearer and the bot's URL come from the process environment the harness
// started the server with (`SWITCHBOARD_RUN_BEARER`, `SWITCHBOARD_HARNESS_URL`);
// nothing here holds a rule, a key or a decision. Shipped as a constant string
// on purpose, like pi's extension: the file the container runs is exactly this
// text, the tests import it from a file they write, and `tsc` carries it to
// `dist/` like any constant.

/** The two reasons the plugin blocks a call with by itself, without a verdict
 *  from the bot — the same words pi's extension uses, so the record reads a
 *  relayed refusal the same on both harnesses. */
export const OC_BLOCKED_AT_DOOR_PREFIX = "authorization refused at the door: ";
export const OC_BLOCKED_UNAVAILABLE_PREFIX = "authorization unavailable: ";

export const OPENCODE_PLUGIN_SOURCE = `// Switchboard's OpenCode plugin. Written into the run's plugin directory by the
// bot before \`opencode serve\` starts; loaded as \`./plugins/switchboard\`'s
// \`index.js\`. Imports nothing.

const BEARER_ENV = "SWITCHBOARD_RUN_BEARER";
const URL_ENV = "SWITCHBOARD_HARNESS_URL";
/** How long the door ask keeps retrying an unreachable bot before it blocks. */
const AUTHORIZE_WAIT_MS = 90000;
const AUTHORIZE_RETRY_MS = 2000;
/** How long one request for a relayed tool's result may take before it is asked
 *  again: over the bot's window (30 s, after which it answers the call is still
 *  running), under this runtime's own header timeout, so a hung connection
 *  costs a minute of the wait, not five. */
const TOOL_REQUEST_TIMEOUT_MS = 60000;
/** How long a relayed call keeps asking a bot it cannot reach before it fails. */
const TOOL_WAIT_MS = 90000;
/** A bot that says a call is still running is asked again no sooner than this,
 *  so a misbehaving bot is never asked in a hot loop. */
const TOOL_REASK_FLOOR_MS = 1000;

function settings() {
  const url = process.env[URL_ENV];
  const bearer = process.env[BEARER_ENV];
  if (!url || !bearer) throw new Error("switchboard plugin: " + URL_ENV + " and " + BEARER_ENV + " must be set");
  return { base: url.replace(/\\/$/, ""), bearer };
}

/** The bot answered, and said no: the status rides along so a caller can tell a
 *  verdict from a bot it could not reach. */
class HarnessAnswerError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function call(method, path, body, signal) {
  const { base, bearer } = settings();
  const res = await fetch(base + path, {
    method,
    headers: { authorization: "Bearer " + bearer, "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const status = res.status;
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new HarnessAnswerError(
      "switchboard plugin: " + method + " " + path + " answered " + status + " with a body that is not JSON",
      status,
    );
  }
  if (!res.ok && status !== 202) {
    throw new HarnessAnswerError(
      "switchboard plugin: " + method + " " + path + " answered " + status + ": " + (json.error || text),
      status,
    );
  }
  return { status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The bot's verdict on one tool call at the door. A verdict answers at once,
 *  and so does a refusal at the door (a 4xx: the bearer wrong, expired or
 *  revoked, the run not on the harness). A bot that cannot be reached or is
 *  failing (a network error, a 5xx, a body that is not JSON) is asked again
 *  every two seconds until the wait is up, then the call is blocked naming why. */
async function authorize(toolCallId, tool, input) {
  const started = Date.now();
  let lastError = "";
  for (;;) {
    try {
      const { json } = await call("POST", "/harness/authorize", { toolCallId, tool, input });
      return json;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const status = err instanceof HarnessAnswerError ? err.status : undefined;
      if (status !== undefined && status >= 400 && status < 500) {
        return { allow: false, reason: "${OC_BLOCKED_AT_DOOR_PREFIX}" + lastError };
      }
      if (Date.now() - started >= AUTHORIZE_WAIT_MS) {
        return { allow: false, reason: "${OC_BLOCKED_UNAVAILABLE_PREFIX}the bot did not answer for 90 s (" + lastError + ")" };
      }
      await sleep(AUTHORIZE_RETRY_MS);
    }
  }
}

/** pi's abort signal for the call, with this request's own timeout beside it
 *  where the runtime can combine the two; the timeout alone where it cannot. */
function requestSignal(signal) {
  const timeout = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(TOOL_REQUEST_TIMEOUT_MS) : undefined;
  if (!timeout) return signal;
  if (!signal) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

/** A relayed tool's result. The call is posted with its id; a bot that answers
 *  that the call is still running (a \`202 pending\`) is asked again with the
 *  same id until it answers: the bot runs the call once and every later ask
 *  joins it. A bot that cannot be reached or is failing (a network error, a
 *  timed-out request, a 5xx) is asked again every two seconds until the wait is
 *  up, then the call fails naming why; a refusal at the door (a 4xx) fails it
 *  at once; an abort ends the asking. */
async function relay(toolCallId, tool, input, signal) {
  let lastAnswered = Date.now();
  let lastError = "";
  for (;;) {
    if (signal && signal.aborted) throw new Error("switchboard plugin: " + tool + " was aborted before the bot answered");
    const asked = Date.now();
    let answer;
    try {
      answer = await call("POST", "/harness/tool", { toolCallId, tool, input }, requestSignal(signal));
    } catch (err) {
      if (signal && signal.aborted) throw err;
      const status = err instanceof HarnessAnswerError ? err.status : undefined;
      if (status !== undefined && status >= 400 && status < 500) throw err;
      lastError = err instanceof Error ? err.message : String(err);
      if (Date.now() - lastAnswered >= TOOL_WAIT_MS) {
        throw new Error("switchboard plugin: the bot did not answer " + tool + " for 90 s (" + lastError + ")");
      }
      await sleep(AUTHORIZE_RETRY_MS);
      continue;
    }
    lastAnswered = Date.now();
    if (answer.status !== 202 && !answer.json.pending) return answer.json;
    const held = Date.now() - asked;
    if (held < TOOL_REASK_FLOOR_MS) await sleep(TOOL_REASK_FLOOR_MS - held);
  }
}

/** One relayed tool's content in OpenCode's shape: pi's text parts joined into
 *  one string, an image part named (OpenCode's tool content carries text or a
 *  file URI, never inline image bytes); never empty. */
function contentText(content) {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  const text = content
    .map((c) => (c && c.type === "text" ? String(c.text) : c && c.type === "image" ? "[image " + (c.mimeType || "") + "]" : ""))
    .filter((t) => t.length > 0)
    .join("\\n");
  return text;
}

/** One relayed tool as OpenCode's editor registers it: a DIRECT tool
 *  (\`codemode: false\`) under its own name and JSON Schema, whose execute runs
 *  the door and the relay with the model's call id. A refusal at the door or an
 *  error from the tool becomes the call's error text — the model reads it. */
function relayTool(def) {
  return {
    name: def.name,
    description: def.description,
    input: def.inputSchema,
    options: { codemode: false },
    async execute(input, context) {
      const callId = context && context.id;
      const verdict = await authorize(callId, def.name, input);
      if (verdict && verdict.allow === false) throw new Error(verdict.reason || "the bot refused this tool call");
      const answer = await relay(callId, def.name, input, context && context.signal);
      const text = contentText(answer.content);
      if (answer.isError) throw new Error(text || "the tool failed");
      return { content: text || "(no output)" };
    },
  };
}

export default {
  id: "switchboard",
  async setup(ctx) {
    const { json } = await call("GET", "/harness/tools");
    const tools = (json && json.tools) || [];
    await ctx.tool.transform((editor) => {
      for (const def of tools) editor.add(relayTool(def));
    });
    // The seam the harness watches for a call OpenCode is about to run; the gate
    // itself rides \`permission.asked\` in the bot, never a decision here.
    ctx.tool.hook("execute.before", () => {});
  },
};
`;
