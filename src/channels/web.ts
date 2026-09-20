import { randomBytes } from "node:crypto";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { allOf, authorize, ownedBy, type Actor } from "../core/authz/index.js";
import { resolveChatActor, type GrantsLookup } from "../core/authz/actor.js";
import type { Capabilities } from "../core/capabilities.js";
import { NO_NAMES, namesOf, type NameDirectory } from "../core/names.js";
import { acceptsUndefined, type CommandDef, type CommandInvoker } from "../core/commandRegistry.js";
import { chatForm, helpRows } from "../core/commandSurface.js";
import { dispatch as realDispatch, type CoreDeps } from "../core/dispatcher.js";
import { startRequestRoot } from "../core/requestTrace.js";
import type { RunRegistry } from "../core/runRegistry.js";
import type { RunRecordView, RunsService, RunView } from "../core/runsService.js";
import { systemClock } from "../core/trace/clock.js";
import type { ChannelIO, ConfirmationOffer, HistoryItem, IncomingMessage, OpenedThread } from "../core/types.js";
import type { AccessIdentity } from "./accessAuth.js";
import { originAllowed } from "./commandHttp.js";
import { HttpIO, MAX_BODY_BYTES, readBody, type DispatchFn } from "./http.js";
import { readableRuns } from "./liveView/viewer.js";
import type {
  HomeCommandSeed,
  HomeConversationRowSeed,
  HomeParentTurnSeed,
  HomeReceiptTurnSeed,
  HomeSeed,
  HomeTurnSeed,
} from "./webSeed.js";
import type { IntakeQuery, IntakeReceipt } from "../core/runLedger/types.js";
import type { PageSender } from "./webShell.js";
import { viewingRefusal } from "../core/authz/viewAs.js";

// The web channel — adapter #5 (docs/decisions/0043, docs/reference/specs/web-chat.md
// item 11): the chat at `/threads`. Like the HTTP ingress it is pure transport:
// `POST /threads/<conversation>/send` turns the body into an `IncomingMessage`
// and calls the same `dispatch()` every channel calls; the pipeline routes,
// gates, admits and records exactly as it would for a Slack DM. The identity is
// the dashboard gate's, never the request's: the browser session is the
// CREDENTIAL (`access:<sub>`, authorization.md item 15), and when record 0042
// linked it to its person the person is the requester and the credential rides
// as `authenticatedAs` — the same shape a bound ingress token sends. The lane is
// the session's own channel `web:<sub>` (a DM by prefix) and the thread key
// `web:<sub>:<conversation>`, so the workspace, the session log and the thread's
// one live slot are keyed as on every channel.
//
// The page seeds (`GET /threads`, `GET /threads/<id>`) are reads over the same
// runs service the runs page reads: a conversation is the runs of one thread,
// the rail is the viewer's own threads across every channel (a thread from
// another channel opens read-only), and the composer's palette is the chat
// catalogue the viewer's actor may run. The adapter writes nothing of its own:
// an exchange the pipeline answered without a run (a hand-back, a `help`
// answer, a steer acknowledgement) is shown once and never seeded again.

const PLATFORM = "web";
/** A fresh conversation id: 20 hex characters, unguessable enough for a key the viewer's own lane scopes. */
const CONVERSATION_ID_BYTES = 10;
/** A conversation id of the viewer's own lane, as the page mints and links them. */
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A full thread key from another channel, as the rail links it (`slack:C…:1712.34`). */
const THREAD_KEY_RE = /^[a-z]+:[A-Za-z0-9_.:@+-]{1,200}$/;
/** Threads in the rail, and runs read for one conversation (record 0043: bounded by the bot, nothing pages). */
export const RAIL_THREADS = 20;
export const CONVERSATION_RUNS = 20;
/** Own runs read to find the viewer's recent threads (a thread may hold several). */
const RAIL_RUNS = 100;
const TITLE_MAX = 60;
/** The rail row's excerpt (its tooltip's full line): long enough to read a
 *  whole ask, short enough that a pasted paragraph stays a tooltip. */
export const EXCERPT_MAX = 240;
const UPSTREAM_REASON_MAX = 400;

export type ThreadsRoute = { kind: "new" } | { kind: "thread"; id: string } | { kind: "send"; id: string };

/** `/threads`, `/threads/<id>` and `/threads/<id>/send`, the id decoded: a
 *  conversation id (the viewer's own lane) or a whole thread key from another
 *  channel. Anything else under the prefix is not a route here. */
export function parseThreadsRoute(pathname: string): ThreadsRoute | null {
  if (pathname === "/threads" || pathname === "/threads/") return { kind: "new" };
  const m = /^\/threads\/([^/]+)(\/send)?\/?$/.exec(pathname);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  if (!CONVERSATION_ID_RE.test(id) && !THREAD_KEY_RE.test(id)) return null;
  return m[2] ? { kind: "send", id } : { kind: "thread", id };
}

export function mintConversationId(): string {
  return randomBytes(CONVERSATION_ID_BYTES).toString("hex");
}

/** The thread key `/threads/<id>` names for this session: its own lane's
 *  conversation, or the whole key another channel's thread carries. */
export function threadKeyFor(sub: string, id: string): string {
  return id.includes(":") ? id : `${PLATFORM}:${sub}:${id}`;
}

/** True when `threadKey` is a conversation of this session's own lane — the only threads it may send into. */
export function ownLane(sub: string, threadKey: string): boolean {
  return threadKey.startsWith(`${PLATFORM}:${sub}:`);
}

/** The `<id>` the rail links a thread by: the conversation for the viewer's own lane, else the key itself. */
export function conversationIdOf(sub: string, threadKey: string): string {
  return ownLane(sub, threadKey) ? threadKey.slice(`${PLATFORM}:${sub}:`.length) : threadKey;
}

/** The identity fields of the message a browser session sends (authorization.md
 *  item 15, as a bound ingress token does): the linked person as `userId` with
 *  the session as `authenticatedAs`, else the session itself, named by its email. */
export function requesterOf(
  actor: Pick<Actor, "id" | "asUser">,
  identity: Pick<AccessIdentity, "email">,
): Pick<IncomingMessage, "userId" | "userName" | "authenticatedAs"> {
  if (actor.asUser)
    return {
      userId: actor.asUser.id,
      ...(actor.asUser.name ? { userName: actor.asUser.name } : {}),
      authenticatedAs: actor.id,
    };
  return { userId: actor.id, ...(identity.email ? { userName: identity.email } : {}) };
}

/** The first non-empty line of a request, cut to `max` characters — the title
 *  of a thread in the rail (the page cuts the tab title the same way). */
export function threadTitle(firstRequest: string, max = TITLE_MAX): string {
  const line =
    firstRequest
      .split(/\r?\n/)
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  if (line.length <= max) return line || "New conversation";
  return `${line.slice(0, max - 1).trimEnd()}…`;
}

/** One run as a turn (web-chat.md item 2): the view as every listing has it,
 *  the request (the first `input` event), the reply (the last `answer`) and the
 *  front door's decision (the `route` event). `token` only for a live run the
 *  viewer may read — what the page's stream attaches with. */
export function turnOf(view: RunRecordView, token?: string): HomeTurnSeed {
  const { events, route: _route, ...rest } = view;
  let request = "";
  let answer: string | undefined;
  let route: HomeTurnSeed["route"];
  for (const e of events ?? []) {
    if (e.type === "input") {
      if (request === "") request = e.text;
    } else if (e.type === "answer") answer = e.text;
    else if (e.type === "route" && route === undefined) route = { preset: e.preset, reason: e.reason };
  }
  return {
    ...rest,
    ...(token !== undefined ? { token } : {}),
    request,
    ...(answer !== undefined ? { answer } : {}),
    ...(route !== undefined ? { route } : {}),
  };
}

/** Any turn of a conversation's seed: a run's, a silent receipt's, the parent's word. */
type ConversationTurn = HomeTurnSeed | HomeReceiptTurnSeed | HomeParentTurnSeed;

/** True for the seed's receipt variant (item 12) — a read-not-answered turn, never a run. */
export function isReceiptTurn(t: ConversationTurn): t is HomeReceiptTurnSeed {
  return "kind" in t && t.kind === "receipt";
}

/** True for a run's own turn — never a receipt's or the parent's word. */
export function isRunTurn(t: ConversationTurn): t is HomeTurnSeed {
  return !("kind" in t);
}

/** Where a turn sits in the thread: a run at its arrival, the parent's word at its stamp. */
function stampOf(t: HomeTurnSeed | HomeParentTurnSeed): number {
  return "kind" in t ? t.at : (t.receivedAt ?? t.startedAt);
}

/** The hosted parent's word merged among the thread's runs by stamp (item 2):
 *  each `ship_unit` event sits where the parent said it. */
export function withParentWord(
  turns: readonly HomeTurnSeed[],
  parents: readonly HomeParentTurnSeed[],
): (HomeTurnSeed | HomeParentTurnSeed)[] {
  if (parents.length === 0) return [...turns];
  const sorted = [...parents].sort((a, b) => a.at - b.at);
  const out: (HomeTurnSeed | HomeParentTurnSeed)[] = [];
  let i = 0;
  for (const t of turns) {
    while (i < sorted.length && sorted[i].at < stampOf(t)) out.push(sorted[i++]);
    out.push(t);
  }
  return [...out, ...sorted.slice(i)];
}

/** The thread's silent receipts merged among its turns by stamp (item 12): a
 *  receipt sits where its message fell — before the first run decided after it
 *  — and the ones after the newest run close the list. */
export function interleaveReceipts(
  turns: readonly (HomeTurnSeed | HomeParentTurnSeed)[],
  receipts: readonly HomeReceiptTurnSeed[],
): ConversationTurn[] {
  if (receipts.length === 0) return [...turns];
  const sorted = [...receipts].sort((a, b) => a.decidedAt - b.decidedAt);
  const out: ConversationTurn[] = [];
  let i = 0;
  for (const t of turns) {
    const at = stampOf(t);
    while (i < sorted.length && sorted[i].decidedAt < at) out.push(sorted[i++]);
    out.push(t);
  }
  return [...out, ...sorted.slice(i)];
}

/** The thread's turns as the history a run reads (`ChannelIO.history`): the
 *  request as the person's line, the reply as the agent's, each stamped. A
 *  receipt turn is no one's line — its message was never stored — and the
 *  parent's word is the parent run's, not this thread's: both are skipped. */
export function historyOf(turns: readonly ConversationTurn[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const t of turns) {
    if (!isRunTurn(t)) continue;
    if (t.request) items.push({ role: "user", text: t.request, at: t.receivedAt ?? t.startedAt });
    if (t.answer !== undefined && t.finishedAt !== undefined)
      items.push({ role: "assistant", text: t.answer, at: t.finishedAt });
  }
  return items;
}

/** What a conversation read needs — the runs service and the registry the
 *  request handler holds, lifted out of its closure (record 0060) so a handle
 *  can be rebuilt from a bare thread key with no request behind it. */
export interface ConversationDeps {
  service: RunsService;
  registry: Pick<RunRegistry, "getById">;
  /** The thread's silent receipts (item 12); absent or null — the runs alone. */
  intake?: { listIntake(query: IntakeQuery): Promise<IntakeReceipt[]> } | null;
  warn?: (message: string) => void;
}

/** The thread's silent receipts as turns (item 12), read only when the viewer
 *  may see the thread — at least one of its runs — so a receipt never reveals
 *  a thread its runs would not; a failing ledger seeds the runs alone. */
async function silentReceiptsOf(
  deps: ConversationDeps,
  threadKey: string,
  visible: boolean,
): Promise<HomeReceiptTurnSeed[]> {
  if (!deps.intake || !visible) return [];
  try {
    const rows = await deps.intake.listIntake({ threadKey });
    return rows
      .filter((r) => r.verdict === "silent")
      .map((r): HomeReceiptTurnSeed => ({ kind: "receipt", reason: r.reason, decidedAt: r.decidedAt }));
  } catch (err) {
    deps.warn?.(
      `intake receipts unavailable (${err instanceof Error ? err.message : String(err)}): ${threadKey} seeds its runs alone`,
    );
    return [];
  }
}

/** The hosted parent's word in this thread (item 2): when the thread's runs
 *  carry an instance tag, the parent run's `ship_unit` events naming this
 *  thread as parent turns — one read of the parent's messages per instance,
 *  under the viewer's own predicate (`parentRunOfInstance` admits the parent as
 *  `listInstanceUnits` does), so an excluded parent seeds nothing. */
async function parentWordsOf(
  deps: ConversationDeps,
  threadKey: string,
  actor: Actor,
  runs: readonly RunView[],
): Promise<HomeParentTurnSeed[]> {
  const instanceIds = [...new Set(runs.map((r) => r.parentInstanceId).filter((id) => id !== undefined))];
  if (instanceIds.length === 0) return [];
  const visibleTo = readableRuns(actor);
  const out: HomeParentTurnSeed[] = [];
  for (const instanceId of instanceIds) {
    const runId = await deps.service.parentRunOfInstance(instanceId, visibleTo);
    if (runId === undefined) continue;
    const read = await deps.service.getRun(runId, { include: "messages" });
    if (!read.ok) continue;
    // The parent's live token, so the link reads while the pipeline runs — a
    // live run's page 404s a tokenless read; the registry only holds live runs,
    // so a finished parent gets none and the bare href reads its record.
    const token = deps.registry.getById(runId)?.token;
    for (const e of read.value.events ?? []) {
      if (e.type !== "ship_unit" || e.threadKey !== threadKey) continue;
      out.push({
        kind: "parent",
        runId,
        ...(token !== undefined ? { token } : {}),
        unit: e.unit,
        state: e.state,
        ...(e.lead !== undefined ? { lead: e.lead } : {}),
        ...(e.report !== undefined ? { report: e.report } : {}),
        ...(e.pr !== undefined ? { pr: e.pr } : {}),
        // An event without a stamp sits at the parent's own start, never at
        // epoch 0 — which would sort the word before the whole conversation.
        at: e.at ?? read.value.startedAt,
      });
    }
  }
  return out;
}

/** The thread's runs the viewer may read, oldest first, with their messages — one read per run, in
 *  parallel — its silent receipts interleaved by decidedAt (item 12) and the hosted parent's word
 *  by its stamp (item 2). The history path passes `receipts: false`: `historyOf` skips receipt and
 *  parent turns anyway, so reading the intake ledger or the parent's record there would only fetch
 *  rows to discard. */
export async function turnsOf(
  deps: ConversationDeps,
  threadKey: string,
  actor: Actor,
  opts?: { receipts?: boolean },
): Promise<{ turns: ConversationTurn[]; runs: RunView[] }> {
  const listed = await deps.service.listRuns({
    status: "all",
    visibleTo: readableRuns(actor),
    threadKey,
    limit: CONVERSATION_RUNS,
  });
  if (listed.storeUnavailable) deps.warn?.(`the run store is unavailable: ${threadKey} seeds its live runs only`);
  const runs = [...listed.runs].sort((a, b) => a.startedAt - b.startedAt);
  const liveToken = (run: RunView): string | undefined =>
    run.finished ? undefined : deps.registry.getById(run.id)?.token;
  const seedOnly = opts?.receipts !== false;
  const [turns, receipts, parents] = await Promise.all([
    Promise.all(
      runs.map(async (run) => {
        const read = await deps.service.getRun(run.id, { include: "messages" });
        return turnOf(read.ok ? read.value : { ...run }, liveToken(run));
      }),
    ),
    seedOnly ? silentReceiptsOf(deps, threadKey, runs.length > 0) : [],
    seedOnly ? parentWordsOf(deps, threadKey, actor, runs) : [],
  ]);
  return { turns: interleaveReceipts(withParentWord(turns, parents), receipts), runs };
}

/** ConversationDeps plus the handle's own knobs: the id generator `openThread`
 *  mints with and where an out-of-request line goes. */
export interface WebHandleDeps extends ConversationDeps {
  mintId?: () => string;
  log?: (line: string) => void;
}

/** A reply with no browser response to ride resolves and logs, never delivers
 *  (run-history item 38's shape): the seal reads this and says `replyOk: false`. */
const WEB_UNDELIVERABLE = "no open web request to deliver to";

/** A web thread's channel handle over a known actor and no request — what
 *  `openThread` hands a child and what `resumeWebIO` rebuilds (record 0060):
 *  `history()` reads the thread's runs as the actor, `openThread` mints a
 *  conversation in the same lane, and a reply is logged as undeliverable. */
export function webThreadIO(deps: WebHandleDeps, thread: { threadKey: string; actor: Actor }): WebIO {
  const [, sub] = thread.threadKey.split(":");
  const log = deps.log ?? ((line: string) => console.log(`[web] ${line}`));
  return new WebIO(
    async (exceptRunId) =>
      historyOf(
        (await turnsOf(deps, thread.threadKey, thread.actor, { receipts: false })).turns.filter(
          (t) => !isRunTurn(t) || t.id !== exceptRunId,
        ),
      ),
    {
      sub,
      mintId: deps.mintId ?? mintConversationId,
      ioFor: (threadKey) => webThreadIO(deps, { threadKey, actor: thread.actor }),
      log,
    },
    { threadKey: thread.threadKey, undeliverable: WEB_UNDELIVERABLE, log },
  );
}

/** The `web:` arm of the bot's `threadIoFor` (record 0060): the handle rebuilt
 *  from a bare thread key and the requester's id alone — the actor resolved as
 *  every chat message's is (`resolveChatActor`), so `history()` lists the
 *  thread's runs as the session's own reader. Undefined for a key that is not
 *  `web:<sub>:<conversation>`. */
export function resumeWebIO(
  deps: WebHandleDeps & { grantsFor: GrantsLookup },
  thread: { threadKey: string; userId: string },
): WebIO | undefined {
  const [platform, sub, conversation] = thread.threadKey.split(":");
  if (platform !== PLATFORM || !sub || !conversation) return undefined;
  const actor = resolveChatActor(
    { userId: thread.userId, channelId: `${PLATFORM}:${sub}`, threadKey: thread.threadKey },
    deps.grantsFor,
  );
  return webThreadIO(deps, { threadKey: thread.threadKey, actor });
}

/** One thread of the viewer's, grouped from their runs: the key, its channel's
 *  platform, its runs (oldest first), when it last moved, whether one is live. */
export interface ThreadGroup {
  threadKey: string;
  surface: string;
  runs: RunView[];
  lastAt: number;
  live: boolean;
}

/** The viewer's runs grouped by thread, newest thread first, the newest
 *  `limit` kept (web-chat.md item 7: the rail is bounded, the runs page holds
 *  the rest). A run without a thread key is nobody's thread and is left out. */
export function threadsOf(runs: readonly RunView[], limit = RAIL_THREADS): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();
  for (const run of runs) {
    if (!run.threadKey) continue;
    const at = run.finishedAt ?? run.startedAt;
    const g = groups.get(run.threadKey);
    if (g) {
      g.runs.push(run);
      g.lastAt = Math.max(g.lastAt, at);
      g.live ||= !run.finished;
    } else {
      groups.set(run.threadKey, {
        threadKey: run.threadKey,
        surface: platformOf(run.channelId ?? run.threadKey),
        runs: [run],
        lastAt: at,
        live: !run.finished,
      });
    }
  }
  const out = [...groups.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, limit);
  for (const g of out) g.runs.sort((a, b) => a.startedAt - b.startedAt);
  return out;
}

function platformOf(id: string): string {
  const colon = id.indexOf(":");
  return colon > 0 ? id.slice(0, colon) : "unknown";
}

/** The `/` palette's rows (web-chat.md item 8): every command the registry
 *  exposes to chat that the viewer's actor may run — the same `authorize` the
 *  registry asks first — in chat form, by name. */
export function paletteCommands(list: readonly CommandDef<unknown>[], actor: Actor): HomeCommandSeed[] {
  return list
    .filter((cmd) => cmd.surfaces?.chat !== false)
    .filter((cmd) => authorize(actor, cmd.action, { type: "command", id: cmd.id }).allow)
    .map((cmd): HomeCommandSeed => {
      // The words that may follow the command, as `help` prints them: the
      // completer offers them level by level after the verb.
      const rows = helpRows(cmd);
      const args = (cmd.args ?? []).map((a) => {
        const name = a.rest ? `${a.name}…` : a.name;
        return acceptsUndefined(a.schema) ? `[${name}]` : `<${name}>`;
      });
      return {
        chat: chatForm(cmd.id),
        describe: cmd.describe,
        ...(args.length > 0 ? { args } : {}),
        ...(rows.options.length > 0
          ? { options: rows.options.map((o) => ({ form: o.form, describe: o.describe })) }
          : {}),
      };
    })
    .sort((a, b) => a.chat.localeCompare(b.chat));
}

/** What the empty state offers (web-chat.md item 2): what Switchboard does well,
 *  grounded in the viewer's own runs — the repository they last worked in, a
 *  run of theirs that failed — and what is on in this process. Every chip
 *  sends on click, so each is a read or a request the door answers safely (a
 *  write is offered as a click row that fills the composer), never a change
 *  started blind. The last chip asks what it can do. */
export function suggestionsFor(input: {
  repos: readonly string[];
  failed: boolean;
  any: boolean;
  capabilities: Pick<Capabilities, "mcp" | "github">;
}): string[] {
  const repo = input.repos[0];
  const chips: string[] = [];
  if (repo) chips.push(`review the open PR on ${repo}`);
  else if (input.capabilities.github) chips.push("review a pull request — paste its link");
  if (input.failed) chips.push("why did my last run fail?");
  else if (input.any) chips.push("what did my last run do?");
  chips.push("what agent and model do I get here?");
  if (input.capabilities.mcp) chips.push("connect an MCP server");
  chips.push("What can Switchboard do?");
  return chips;
}

/** The lane a web handle opens child threads in (thread-admission item 6,
 *  record 0060): a conversation id minted under the same sub, the child's
 *  handle built by the same reader, the lead's length logged — the browser is
 *  told nothing live; the conversation renders from the run records. */
export interface WebLane {
  sub: string;
  mintId: () => string;
  ioFor: (threadKey: string) => ChannelIO;
  log: (line: string) => void;
}

/** The web channel's `ChannelIO`: the ingress IO's single-shot shape (replies
 *  collected, `runStarted` raced against completion, the receipt kept) with
 *  the thread's history read from the run store when a run asks for it. The
 *  run this request became is registered — its `input` published — before the
 *  core reads history, so it is in the thread's runs; history excludes the
 *  triggering message on every channel (`ChannelIO.history`), so the asking
 *  run's own turn is left out here. With a `lane` the handle can open a thread
 *  of its own — what admits the web to `agent:ship` (record 0060); a `resume`
 *  handle (rebuilt with no request behind it) logs its replies as
 *  undeliverable instead of collecting them for a response nobody awaits.
 *  The web chat is a chat surface (record 0069): `offer` collects the
 *  confirmation a routed write is offered as, the send response carries the
 *  row's line and risk, and the page fills its composer from that click row —
 *  never from a typed-form refusal, which no chat surface renders. */
export class WebIO extends HttpIO {
  private runId: string | undefined;
  private offerShown: ConfirmationOffer | undefined;
  /** Present when this handle can open a thread of its own (thread-admission item 6). */
  openThread?: (lead: string) => Promise<OpenedThread>;
  /** Set on a rebuilt handle: the seal reads it (`replyOk: false`). */
  readonly undeliverable?: string;
  private replyLog?: (text: string) => void;
  constructor(
    private readonly turns: (exceptRunId: string | undefined) => Promise<HistoryItem[]>,
    lane?: WebLane,
    private readonly resume?: { threadKey: string; undeliverable: string; log: (line: string) => void },
  ) {
    super();
    if (lane)
      this.openThread = async (lead: string): Promise<OpenedThread> => {
        const threadKey = `${PLATFORM}:${lane.sub}:${lane.mintId()}`;
        lane.log(`${threadKey} opened for a child run: ${lead.length} chars`);
        return { thread: { threadKey }, io: lane.ioFor(threadKey) };
      };
    if (resume) {
      this.undeliverable = resume.undeliverable;
      this.replyLog = (text) => resume.log(`${resume.threadKey} reply (${resume.undeliverable}): ${text.length} chars`);
    }
  }
  override async reply(text: string): Promise<void> {
    if (this.resume) {
      this.replyLog?.(text);
      return;
    }
    return super.reply(text);
  }
  /** The click row as the browser shows it: the send response carries the
   *  line (and its risk or question) and the composer is the affordance — the
   *  person sends the filled line, which runs as typed. */
  async offer(offer: ConfirmationOffer): Promise<void> {
    if (this.resume) {
      this.replyLog?.(offer.line);
      return;
    }
    this.offerShown = offer;
  }
  /** The offer this request collected, when the door minted one. */
  offered(): ConfirmationOffer | undefined {
    return this.offerShown;
  }
  override runStarted(started: { id: string }): void {
    this.runId = started.id;
    super.runStarted(started);
  }
  override history(): Promise<HistoryItem[]> {
    return this.turns(this.runId);
  }
}

export interface WebChatDeps {
  /** The core the adapter dispatches into. */
  core: CoreDeps;
  /** Every run read: the thread's runs, their messages, the viewer's own threads. */
  service: RunsService;
  /** The live rows' capability tokens (the `202`'s view path, a live turn's stream). */
  registry: Pick<RunRegistry, "getById">;
  /** The catalogue the palette lists from. */
  commands: Pick<CommandInvoker, "list">;
  page: PageSender;
  capabilities: Capabilities;
  /** Display names for the rail's channels (src/core/names.ts); absent → ids only. */
  names?: NameDirectory;
  /** null when run history is off (store: null). */
  retention: { retentionDays: number } | null;
  /** The intake receipts the thread view interleaves as read-not-answered turns
   *  (item 12; run-history item 59): the run ledger's `listIntake`. null when
   *  the ledger is off — the seed then carries the runs alone. */
  intake: { listIntake(query: IntakeQuery): Promise<IntakeReceipt[]> } | null;
  /** `PUBLIC_BASE_URL`, when set: the origin a send must come from. */
  publicBaseUrl?: string;
  /** Defaults to the real core dispatch(); overridden in tests. */
  dispatch?: DispatchFn;
  maxBodyBytes?: number;
  now?: () => number;
  mintId?: () => string;
  warn?: (message: string) => void;
}

export interface WebChatContext {
  /** The gate's actor, linked to its person when the session's email named one (record 0042). */
  actor: Actor;
  identity: AccessIdentity;
}

type Json = (status: number, body: unknown) => void;

export function createWebChatHandler(
  deps: WebChatDeps,
): (req: HttpRequest, res: ServerResponse, ctx: WebChatContext) => boolean {
  const now = deps.now ?? systemClock;
  const mintId = deps.mintId ?? mintConversationId;
  const warn = deps.warn ?? ((m: string) => console.warn(`[web] ${m}`));
  const dispatchFn = deps.dispatch ?? realDispatch;
  const maxBytes = deps.maxBodyBytes ?? MAX_BODY_BYTES;
  const retentionDays = deps.retention ? deps.retention.retentionDays : null;

  const subOf = (actor: Actor): string => actor.id.replace(/^access:/, "");
  /** The conversation reader, shared with the rebuilt handles (record 0060). */
  const conv: ConversationDeps = { service: deps.service, registry: deps.registry, intake: deps.intake, warn };
  const readTurns = (threadKey: string, actor: Actor, opts?: { receipts?: boolean }) =>
    turnsOf(conv, threadKey, actor, opts);

  /** The rail: the viewer's own threads across every channel, titled by each first request. */
  async function railOf(actor: Actor, sub: string): Promise<{ rows: HomeConversationRowSeed[]; runs: RunView[] }> {
    const listed = await deps.service.listRuns({
      status: "all",
      visibleTo: allOf([readableRuns(actor), ownedBy(actor)]),
      limit: RAIL_RUNS,
    });
    const groups = threadsOf(listed.runs);
    // The channel behind a thread from another surface, named when the directory knows it
    // (record 0042, the dashboard reads names): one ask per distinct channel, concurrent.
    const channelOf = (g: ThreadGroup): string | undefined =>
      g.surface === PLATFORM ? undefined : (g.runs[0]?.channelId ?? undefined);
    const channelNames = await namesOf(
      (id) => (deps.names ?? NO_NAMES).channel(id),
      groups.map(channelOf).filter((id): id is string => id !== undefined),
    );
    const rows = await Promise.all(
      groups.map(async (g): Promise<HomeConversationRowSeed> => {
        // The thread's first request, from the oldest run that recorded one: a
        // run refused before its request was published (a died ship attempt)
        // has no `input`, and its label is the card's head, not a title.
        let request = "";
        for (const run of g.runs) {
          const read = await deps.service.getRun(run.id, { include: "messages" });
          request = read.ok ? turnOf(read.value).request : "";
          if (request !== "") break;
        }
        const first = g.runs[0];
        const line = request || first.label || first.id;
        const channelId = channelOf(g);
        const channelName = channelId ? channelNames.get(channelId) : undefined;
        return {
          id: conversationIdOf(sub, g.threadKey),
          title: threadTitle(line),
          excerpt: threadTitle(line, EXCERPT_MAX),
          lastAt: g.lastAt,
          runs: g.runs.length,
          live: g.live,
          surface: g.surface,
          ...(channelId ? { channelId } : {}),
          ...(channelName ? { channelName } : {}),
        };
      }),
    );
    return { rows, runs: listed.runs };
  }

  async function seedFor(
    ctx: WebChatContext,
    conversation: string,
    threadKey: string,
    open: { turns: ConversationTurn[]; runs: RunView[] },
  ): Promise<HomeSeed> {
    const sub = subOf(ctx.actor);
    const rail = await railOf(ctx.actor, sub);
    const mine = rail.runs;
    const repos = [...new Set(mine.map((r) => r.repo).filter((r): r is string => r !== undefined))];
    const foreign = !ownLane(sub, threadKey);
    return {
      page: "home",
      conversation,
      turns: open.turns,
      conversations: rail.rows,
      viewer: { name: ctx.actor.asUser?.name ?? ctx.identity.email ?? sub },
      sendUrl: `/threads/${encodeURIComponent(conversation)}/send`,
      lane: `${PLATFORM}:${sub}`,
      ...(foreign
        ? {
            elsewhere: {
              surface: platformOf(threadKey),
              ...(() => {
                const url = open.runs.find((r) => r.sourceUrl)?.sourceUrl;
                return url ? { url } : {};
              })(),
            },
          }
        : {}),
      now: now(),
      retentionDays,
      suggestions: suggestionsFor({
        repos,
        failed: mine.some((r) => r.status === "failed"),
        any: mine.length > 0,
        capabilities: deps.capabilities,
      }),
      commands: paletteCommands(deps.commands.list(), ctx.actor),
    };
  }

  /** `POST /threads/<id>/send`: the body's text into `dispatch()` as this session (web-chat.md item 11). */
  async function send(req: HttpRequest, res: ServerResponse, ctx: WebChatContext, id: string): Promise<void> {
    const answer: Json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (!originAllowed(req, { publicBaseUrl: deps.publicBaseUrl })) {
      answer(403, { error: "forbidden_origin" });
      req.destroy();
      return;
    }
    const ct = (
      Array.isArray(req.headers["content-type"]) ? req.headers["content-type"][0] : req.headers["content-type"]
    )
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    if (ct !== "application/json") {
      answer(415, { error: "unsupported_media_type" });
      req.destroy();
      return;
    }
    if (ctx.actor.viewingAs) {
      // Viewing as a person is read-only (record 0053): the chat is the person's to speak in.
      answer(403, { error: "unauthorized", message: viewingRefusal(ctx.actor.viewingAs) });
      req.destroy();
      return;
    }
    const sub = subOf(ctx.actor);
    const threadKey = threadKeyFor(sub, id);
    if (!ownLane(sub, threadKey)) {
      // A thread from another channel is read here and answered there.
      answer(403, { error: "forbidden", detail: `this thread lives on ${platformOf(threadKey)}; reply there` });
      req.destroy();
      return;
    }
    const read = await readBody(req, maxBytes);
    if (!read.ok) {
      answer(413, { error: "request body too large" });
      req.destroy();
      return;
    }
    let text: string;
    try {
      const parsed = JSON.parse(read.body) as { text?: unknown };
      if (typeof parsed !== "object" || parsed === null || typeof parsed.text !== "string" || parsed.text.trim() === "")
        throw new Error("shape");
      text = parsed.text;
    } catch {
      answer(400, { error: "`text` is required and must be a non-empty string" });
      return;
    }
    // The request's root (docs/reference/specs/tracing.md): the identity is the
    // gate's, the body is parsed; `dispatch()` ends it.
    const receivedAt = now();
    const trace = startRequestRoot(deps.core, { channel: "web", receivedAt });
    const msg: IncomingMessage = {
      ...requesterOf(ctx.actor, ctx.identity),
      channelId: `${PLATFORM}:${sub}`,
      threadKey,
      text,
      receivedAt,
    };
    const io = new WebIO(
      async (exceptRunId) =>
        historyOf(
          (await readTurns(threadKey, ctx.actor, { receipts: false })).turns.filter(
            (t) => !isRunTurn(t) || t.id !== exceptRunId,
          ),
        ),
      // The lane: this handle can open a thread of its own — a conversation in
      // the session's lane — which is what admits the web to `agent:ship`
      // (record 0060; thread-admission item 6).
      {
        sub,
        mintId,
        ioFor: (key) => webThreadIO({ ...conv, mintId, log: warn }, { threadKey: key, actor: ctx.actor }),
        log: warn,
      },
    );
    // Started, not awaited: the dispatcher counts the run from its first line,
    // so the shutdown drain waits for it like any run; its errors are its own.
    const done = dispatchFn(deps.core, msg, io, { trace }).catch((err) => {
      warn(`dispatch: ${err instanceof Error ? err.message : String(err)}`);
    });
    // The run's creation raced against completion: a request the pipeline
    // answers without a run (a hand-back, a `help` answer, a steer, a refusal)
    // ends dispatch with no `runStarted` and gets its reply text.
    const started = await Promise.race([io.started, done.then(() => undefined)]);
    const token = started ? deps.registry.getById(started.id)?.token : undefined;
    if (started && token !== undefined) {
      answer(202, {
        runId: started.id,
        viewPath: `/runs/${encodeURIComponent(started.id)}?t=${token}`,
        threadKey,
      });
      return;
    }
    // A run that left the registry before its token was read is answered like
    // a run-less request: its reply. A run leaves the registry only through
    // `discard` (a run the dispatcher abandoned before it ran) or the sweep
    // after `finish`, both on dispatch's way out — so `done` settles at once
    // here; a live run always has its token, and takes the `202` above.
    await done;
    const run = io.run();
    const offer = io.offered();
    answer(200, {
      reply: io.collected(),
      ...(offer
        ? {
            offer: {
              line: offer.line,
              ...(offer.risk ? { risk: offer.risk } : {}),
              ...(offer.question ? { question: offer.question.text } : {}),
            },
          }
        : {}),
      ...(run ? { run } : {}),
    });
  }

  return (req, res, ctx) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parseThreadsRoute(url.pathname);
    if (!route) return false;
    const method = (req.method ?? "GET").toUpperCase();
    const plain = (status: number, body: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra });
      res.end(body);
    };
    const failed = (err: unknown) => {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, UPSTREAM_REASON_MAX);
      if (res.headersSent) {
        warn(`render failed after the head was sent: ${reason}`);
        res.end();
        return;
      }
      plain(502, `threads unavailable: ${reason}`);
    };
    if (route.kind === "send") {
      if (method !== "POST") {
        plain(405, "method not allowed", { allow: "POST" });
        return true;
      }
      send(req, res, ctx, route.id).catch(failed);
      return true;
    }
    if (method !== "GET") {
      plain(405, "method not allowed", { allow: "GET" });
      return true;
    }
    const render = (title: string, seed: HomeSeed) => deps.page(req, res, 200, ctx.actor, title, seed);
    const sub = subOf(ctx.actor);
    if (route.kind === "new") {
      const conversation = mintId();
      seedFor(ctx, conversation, threadKeyFor(sub, conversation), { turns: [], runs: [] })
        .then((seed) => render("Threads", seed))
        .catch(failed);
      return true;
    }
    const threadKey = threadKeyFor(sub, route.id);
    readTurns(threadKey, ctx.actor)
      .then(async (open) => {
        // A thread from another channel the viewer may see nothing of is the
        // same 404 an unknown run gives (live-view item 19): existence is never
        // revealed. The viewer's own lane is theirs to open empty.
        if (open.runs.length === 0 && !ownLane(sub, threadKey)) {
          deps.page(req, res, 404, ctx.actor, "Run not found", { page: "runNotFound", retentionDays });
          return;
        }
        const seed = await seedFor(ctx, route.id, threadKey, open);
        const liveCount = open.runs.filter((r) => !r.finished).length;
        render(`${liveCount > 0 ? `(${liveCount}) ` : ""}Threads`, seed);
      })
      .catch(failed);
    return true;
  };
}
