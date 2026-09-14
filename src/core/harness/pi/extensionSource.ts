// The pi extension a run's container loads (docs/reference/specs/harness-pi.md
// item 7), as the text the harness writes there before pi starts. Plain
// JavaScript that imports nothing: pi's own loader (jiti) runs it as written
// in a directory with no node_modules. It does two things. It registers the
// run's relayed tools — the definitions it fetches from the bot, one JSON
// Schema each — so `update_status`, `submit_pr_description` and the rest run
// in the bot with the run's own context and answer here; and its `tool_call`
// hook asks the bot before every tool executes, pi's own included, and blocks
// with the bot's reason when the bot refuses or cannot be reached for long
// enough. The bearer and the bot's URL come from the process environment the
// harness started pi with; nothing here holds a rule, a key or a decision.
//
// Shipped as a string on purpose: the file the container runs is exactly this
// text, the tests import it from a file they write, and `tsc` carries it to
// `dist/` like any constant.

export const PI_EXTENSION_SOURCE = `// Switchboard's pi harness extension. Written into the run's directory by the
// bot before pi starts; loaded with \`-e\`. Imports nothing.

const BEARER_ENV = "SWITCHBOARD_RUN_BEARER";
const URL_ENV = "SWITCHBOARD_HARNESS_URL";
/** How long the tool_call hook keeps asking an unreachable bot before it blocks. */
const AUTHORIZE_WAIT_MS = 90_000;
const AUTHORIZE_RETRY_MS = 2_000;

function settings() {
  const url = process.env[URL_ENV];
  const bearer = process.env[BEARER_ENV];
  if (!url || !bearer) throw new Error("switchboard harness: " + URL_ENV + " and " + BEARER_ENV + " must be set");
  return { base: url.replace(/\\/$/, ""), bearer };
}

/** The bot answered, and said no: the status rides along so a caller can tell
 *  a verdict from a bot it could not reach. */
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
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("switchboard harness: " + method + " " + path + " answered " + res.status + " with a body that is not JSON");
  }
  if (!res.ok) {
    throw new HarnessAnswerError(
      "switchboard harness: " + method + " " + path + " answered " + res.status + ": " + (json.error || text),
      res.status,
    );
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The bot's verdict on one tool call. A verdict answers at once, and so does
 *  a refusal at the door — a 4xx: the bearer wrong, expired or revoked, the
 *  run not on the harness — since nothing later changes it. A bot that cannot
 *  be reached or is failing (a network error, a 5xx, a body that is not JSON)
 *  is asked again every two seconds until the wait is up, then the call is
 *  blocked naming why. */
async function authorize(event) {
  const started = Date.now();
  let lastError = "";
  for (;;) {
    try {
      return await call("POST", "/harness/authorize", {
        toolCallId: event.toolCallId,
        tool: event.toolName,
        input: event.input,
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const status = err instanceof HarnessAnswerError ? err.status : undefined;
      if (status !== undefined && status >= 400 && status < 500) {
        return { allow: false, reason: "authorization refused at the door: " + lastError };
      }
      if (Date.now() - started >= AUTHORIZE_WAIT_MS) {
        return { allow: false, reason: "authorization unavailable: the bot did not answer for 90 s (" + lastError + ")" };
      }
      await sleep(AUTHORIZE_RETRY_MS);
    }
  }
}

function relayTool(def) {
  return {
    name: def.name,
    label: def.name,
    description: def.description,
    parameters: def.inputSchema,
    async execute(toolCallId, params, signal) {
      const answer = await call("POST", "/harness/tool", { toolCallId, tool: def.name, input: params }, signal);
      if (answer.isError) throw new Error(answer.content.map((c) => (c.type === "text" ? c.text : "")).join("\\n"));
      return { content: answer.content, details: {} };
    },
  };
}

export default async function switchboardHarness(pi) {
  const { tools } = await call("GET", "/harness/tools");
  for (const def of tools) pi.registerTool(relayTool(def));
  pi.on("tool_call", async (event) => {
    const verdict = await authorize(event);
    if (!verdict.allow) return { block: true, reason: verdict.reason };
    return undefined;
  });
}
`;
