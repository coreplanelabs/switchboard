// The tailer a run's container runs beside `opencode serve` (docs/reference/specs/harness.md,
// the OpenCode process item; record 0038's fourth amendment: "the store is the
// truth and the stream an accelerator"), as the text the harness writes into
// the run's directory and starts through the container seam with `node`, the
// runtime every image and the bot host already carry. Its stdout is the run's
// feed (`feed.jsonl`): the seam's wrapper appends it there, and the harness
// reads that file through pi's log transport by offset, on every container
// class, so no executor holds a stream open and a re-attach continues from a
// byte. It subscribes to the server's event stream over loopback with the
// run's password (Basic auth, from the environment the seam started it with;
// never an argument), writes each event as one JSON line, reconnects with a
// bounded backoff when the stream drops — it is volatile by contract — and
// at every step's end (and every execution's end) appends two more records
// from the store: the session's pending asks and the messages that changed
// since its previous refill of that session, diffed by message id against
// the list it keeps in memory, so the feed grows with the work and not with
// the session. A reconnect refills every session it knows, so a turn that
// ended while the stream was down still lands. It exits when the server's
// process is gone. Plain CommonJS that requires only Node's own modules.
//
// Shipped as a string on purpose, like pi's extension: the file the container
// runs is exactly this text, the tests write it to a file and run it under
// node, and `tsc` carries it to `dist/` like any constant.

/** The variable the tailer reads the server's pid from: it exits once that process is gone. */
export const OPENCODE_SERVE_PID_ENV = "SWITCHBOARD_SERVE_PID";

export const OPENCODE_TAILER_SOURCE = `// Switchboard's OpenCode tailer. Written into the run's directory by the bot
// and started beside \`opencode serve\`; its stdout is the run's feed. Requires
// only Node's own modules.
"use strict";
const http = require("node:http");

const port = Number(process.env.SWITCHBOARD_HARNESS_PORT);
const password = process.env.OPENCODE_PASSWORD || "";
const servePid = Number(process.env.SWITCHBOARD_SERVE_PID) || 0;
const auth = "Basic " + Buffer.from("opencode:" + password).toString("base64");
const REFILL_ON = new Set([
  "session.step.ended",
  "session.step.failed",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);
const MIN_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;
const REQUEST_TIMEOUT_MS = 30000;
const PAGE_LIMIT = 200;

/** sessionID -> Map(messageID -> the message as JSON text): the last list each refill saw. */
const known = new Map();
/** Refills run one at a time, in the order their step ends arrived, so the feed's records keep that order. */
let pending = Promise.resolve();
let backoffMs = MIN_BACKOFF_MS;
let connections = 0;

function emit(record) {
  process.stdout.write(JSON.stringify(record) + "\\n");
}

function note(text, extra) {
  emit(Object.assign({ feed: "tailer", at: Date.now(), note: text }, extra || {}));
}

function detailOf(err) {
  return String((err && err.message) || err).slice(0, 300);
}

function request(method, path, accept) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { authorization: auth, accept } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("the request timed out")));
    req.end();
  });
}

async function getJson(path) {
  const res = await request("GET", path, "application/json");
  if (res.status !== 200) throw new Error("GET " + path + " answered " + res.status);
  return JSON.parse(res.body);
}

/** The session's pending asks, whole; then its messages, the changed ones only. */
async function refill(sessionID, reason) {
  const at = Date.now();
  try {
    const answer = await getJson("/api/session/" + sessionID + "/permission");
    emit({ feed: "permissions", at, sessionID, reason, data: Array.isArray(answer.data) ? answer.data : [] });
  } catch (err) {
    note("permission refill failed", { sessionID, reason, detail: detailOf(err) });
  }
  try {
    const all = [];
    let cursor;
    for (let page = 0; page < 10000; page++) {
      const query = (cursor ? "cursor=" + encodeURIComponent(cursor) : "order=asc") + "&limit=" + PAGE_LIMIT;
      const answer = await getJson("/api/session/" + sessionID + "/message?" + query);
      for (const message of Array.isArray(answer.data) ? answer.data : []) all.push(message);
      cursor = answer.cursor && answer.cursor.next;
      if (!cursor) break;
    }
    const seen = known.get(sessionID) || new Map();
    const changed = [];
    for (const message of all) {
      const text = JSON.stringify(message);
      if (seen.get(message.id) !== text) {
        seen.set(message.id, text);
        changed.push(message);
      }
    }
    known.set(sessionID, seen);
    emit({ feed: "messages", at, sessionID, reason, data: changed });
  } catch (err) {
    note("message refill failed", { sessionID, reason, detail: detailOf(err) });
  }
}

function queueRefill(sessionID, reason) {
  pending = pending.then(() => refill(sessionID, reason));
}

function onEvent(event) {
  emit({ feed: "event", at: Date.now(), event });
  if (REFILL_ON.has(event.type) && event.data && typeof event.data.sessionID === "string")
    queueRefill(event.data.sessionID, event.type);
}

function connected() {
  connections++;
  backoffMs = MIN_BACKOFF_MS;
  note(connections === 1 ? "connected" : "reconnected", { connections });
  // A gap is possible only after a drop: refill what a step end during it would have.
  if (connections > 1) for (const sessionID of known.keys()) queueRefill(sessionID, "reconnect");
}

/** One subscription; resolves with why it ended. Blocks are \`data:\` lines
 *  ended by a blank line; a comment line (the heartbeat) has no data. */
function subscribe() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path: "/api/event", headers: { authorization: auth, accept: "text/event-stream" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          res.on("end", () => resolve("the event stream answered " + res.statusCode));
          return;
        }
        connected();
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          let cut;
          while ((cut = buffer.indexOf("\\n\\n")) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = block
              .split("\\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\\n");
            if (!data) continue;
            try {
              onEvent(JSON.parse(data));
            } catch (err) {
              note("an event was not JSON", { detail: data.slice(0, 200) });
            }
          }
        });
        res.on("end", () => resolve("the event stream ended"));
        res.on("error", (err) => resolve("the event stream failed: " + detailOf(err)));
      },
    );
    req.on("error", (err) => resolve("the event stream could not be opened: " + detailOf(err)));
    req.end();
  });
}

function serveAlive() {
  if (!servePid) return true;
  try {
    process.kill(servePid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

async function main() {
  note("started", { port, servePid });
  for (;;) {
    const why = await subscribe();
    note("stream closed", { detail: why });
    await pending.catch(() => {});
    if (!serveAlive()) {
      note("the server process is gone; exiting");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
  }
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
main().then(
  () => process.exit(0),
  (err) => {
    note("tailer failed", { detail: String((err && err.stack) || err).slice(0, 600) });
    process.exit(1);
  },
);
`;
