// The pi extension a run's container loads (docs/reference/specs/harness-pi.md
// item 7), as the text the harness writes there before pi starts. Plain
// JavaScript that imports nothing: pi's own loader (jiti) runs it as written
// in a directory with no node_modules. It does two things. It registers the
// run's relayed tools — the definitions it fetches from the bot, one JSON
// Schema each — so `update_status`, `submit_pr_description` and the rest run
// in the bot with the run's own context and answer here, a call the bot says
// is still running asked again with the same call id until it answers (the
// conductor's waits run for minutes; the bot runs the call once); and its
// `tool_call` hook asks the bot before every tool executes, pi's own included,
// and blocks with the bot's reason when the bot refuses or cannot be reached
// for long enough. Its `session_before_compact` hook asks the bot how the
// compaction pi is about to write is written — pi's own summary, or the bot's
// pointer summary after one that failed for good — and hands pi the bot's
// compaction under pi's own kept entry and size; a bot that cannot be reached
// leaves the compaction to pi. The bearer and the bot's URL come from the
// process environment the harness started pi with; nothing here holds a rule,
// a key or a decision.
//
// Shipped as a string on purpose: the file the container runs is exactly this
// text, the tests import it from a file they write, and `tsc` carries it to
// `dist/` like any constant.

/** The two reasons the extension blocks a call with by itself, without a
 *  verdict from the bot: a refusal at the door (a 4xx) and a bot that did not
 *  answer for the wait. The bridge reads them off pi's `tool_execution_end`
 *  (harness-pi item 7) to tell such a call — blocked, nothing ran — from one
 *  that ran without the gate ever seeing it. */
export const BLOCKED_AT_DOOR_PREFIX = "authorization refused at the door: ";
export const BLOCKED_UNAVAILABLE_PREFIX = "authorization unavailable: ";

export const PI_EXTENSION_SOURCE = `// Switchboard's pi harness extension. Written into the run's directory by the
// bot before pi starts; loaded with \`-e\`. Imports nothing.

const BEARER_ENV = "SWITCHBOARD_RUN_BEARER";
const URL_ENV = "SWITCHBOARD_HARNESS_URL";
/** How long the tool_call hook keeps asking an unreachable bot before it blocks. */
const AUTHORIZE_WAIT_MS = 90_000;
const AUTHORIZE_RETRY_MS = 2_000;
/** How long one request for a relayed tool's result may take before it is asked
 *  again: over the bot's window (30 s, after which it answers that the call is
 *  still running), under this runtime's own five-minute header timeout on a
 *  fetch, so a hung connection costs a minute of the wait, not five. */
const TOOL_REQUEST_TIMEOUT_MS = 60_000;
/** How long a relayed call keeps asking a bot it cannot reach before it fails; the cadence is the hook's. */
const TOOL_WAIT_MS = 90_000;
/** A bot that says a call is still running is asked again after the window it
 *  held the request for; one that answered sooner is asked again no sooner
 *  than this, so a misbehaving bot is never asked in a hot loop. */
const TOOL_REASK_FLOOR_MS = 1_000;

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
        return { allow: false, reason: "${BLOCKED_AT_DOOR_PREFIX}" + lastError };
      }
      if (Date.now() - started >= AUTHORIZE_WAIT_MS) {
        return { allow: false, reason: "${BLOCKED_UNAVAILABLE_PREFIX}the bot did not answer for 90 s (" + lastError + ")" };
      }
      await sleep(AUTHORIZE_RETRY_MS);
    }
  }
}

/** pi's abort signal for the call, with this request's own timeout beside it
 *  where the runtime can combine the two; pi's alone where it cannot. */
function requestSignal(signal) {
  const timeout = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(TOOL_REQUEST_TIMEOUT_MS) : undefined;
  if (!timeout) return signal;
  if (!signal) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

/** A relayed tool's result. The call is posted with its id; a bot that answers
 *  that the call is still running (a wait on other runs can take minutes) is
 *  asked again with the same id until it answers: the bot runs the call once
 *  and every later ask joins it. A bot that cannot be reached or is failing (a
 *  network error, a timed-out request, a 5xx) is asked again every two seconds
 *  until the wait is up, then the call fails naming why; a refusal at the door
 *  (a 4xx) fails it at once; an abort from pi ends the asking. */
async function relay(toolCallId, tool, input, signal) {
  let lastAnswered = Date.now();
  let lastError = "";
  for (;;) {
    if (signal && signal.aborted) throw new Error("switchboard harness: " + tool + " was aborted before the bot answered");
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
        throw new Error("switchboard harness: the bot did not answer " + tool + " for 90 s (" + lastError + ")");
      }
      await sleep(AUTHORIZE_RETRY_MS);
      continue;
    }
    lastAnswered = Date.now();
    if (!answer.pending) return answer;
    const held = Date.now() - asked;
    if (held < TOOL_REASK_FLOOR_MS) await sleep(TOOL_REASK_FLOOR_MS - held);
  }
}

function relayTool(def) {
  return {
    name: def.name,
    label: def.name,
    description: def.description,
    parameters: def.inputSchema,
    async execute(toolCallId, params, signal) {
      const answer = await relay(toolCallId, def.name, params, signal);
      if (answer.isError) throw new Error(answer.content.map((c) => (c.type === "text" ? c.text : "")).join("\\n"));
      return { content: answer.content, details: {} };
    },
  };
}

/** pi's own file lists for the turns a compaction drops (its \`computeFileLists\`
 *  over the preparation's \`fileOps\`): the files written or edited, and the
 *  files only read. */
function fileLists(fileOps) {
  const list = (set) => Array.from(set || []);
  const modified = new Set([...list(fileOps && fileOps.edited), ...list(fileOps && fileOps.written)]);
  return {
    readFiles: list(fileOps && fileOps.read).filter((f) => !modified.has(f)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

/** The bot's word on the compaction pi is about to write: asked once with the
 *  preparation's facts — pi's own summary stands when the bot says nothing,
 *  cannot be reached or refuses — and the bot's summary becomes the
 *  extension's compaction under pi's own first kept entry and size. */
async function compaction(event) {
  const preparation = event.preparation;
  if (!preparation) return undefined;
  const files = fileLists(preparation.fileOps);
  let answer;
  try {
    answer = await call(
      "POST",
      "/harness/compaction",
      {
        reason: event.reason,
        tokensBefore: preparation.tokensBefore,
        previousSummary: preparation.previousSummary,
        readFiles: files.readFiles,
        modifiedFiles: files.modifiedFiles,
      },
      requestSignal(event.signal),
    );
  } catch {
    return undefined;
  }
  if (!answer || typeof answer.summary !== "string") return undefined;
  return {
    compaction: {
      summary: answer.summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: files,
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
  pi.on("session_before_compact", compaction);
}
`;
