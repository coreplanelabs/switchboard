// The OpenCode harness (docs/reference/specs/harness.md item 7): OpenCode as the
// contract's second object. `open` is the run — the server started and the
// tailer beside it (U10's `launchOpenCode`), the run registered on the relay so
// the plugin's `/harness/*` posts are answered, the thread's earlier turns
// imported as an authored session and the request prompted, then the
// gate-and-record loop (`driveOpenCode`, U11) driven to its answer while a
// concurrent drainer steers the thread's follow-ups in — and the process left
// alive on its session for the post-turns, ended on `end`. `find` says where a
// row's OpenCode is before any pid is probed; `end` kills the server and its
// tailer and removes the root. The conversation verbs: the request
// and the post-turns are `prompt { delivery: "queue" }`, the follow-ups and the
// wind-down are `prompt { delivery: "steer" }`, the hard stop is `interrupt`.
//
// The launch, the seed import and the process's end are wired here; the gate,
// the record and the budgets are `driveOpenCode`'s. A resume whose server still
// answers in this container re-attaches onto it: the row's `bearerHash` is the
// server's password, the store is read back to align the mirror past the
// ledger's rows, the asks pending on the server are decided through the gate,
// the tailer is kept or restarted over the same feed, and the feed is read from
// the row's `logOffset` — nothing replayed as a decision, nothing skipped. A
// resume whose server is gone rebuilds from the record: the ledger's transcript
// imported into a fresh store with the settlement of any call in flight; a
// server that answers but cannot be re-attached (its password refused, its
// session gone, its feed unreadable) is ended before that fresh start, the
// `resumed` note saying why. The relaunch ceiling under a living bot (a
// container replaced mid-run, the bearer rotated, at most twice) is the
// OpenCode half of the survival clause the run loop drives; this module builds
// the rebuild path `open` takes with a resume, so that loop can call it.

import { MINUTE_MS, turnLeaseMs } from "../../budgets.js";
import type { Identity } from "../../../agents/registry.js";
import type { Effort } from "../../../effort.js";
import { followUpMessageId, followUpPrompt, followUpSnippet, type FollowUpInput } from "../../threadAdmission.js";
import { redactAndCap, redactSecrets, type RunEvent, type RunNoteKind } from "../../runEvents.js";
import {
  identityOrNothing,
  isContainerGone,
  isControlReset,
  LOG_READ_BYTES,
  OP_TIMEOUT_MS,
  type HarnessContainer,
  type HarnessResponse,
} from "../container.js";
import {
  HarnessContainerReplacedError,
  type Finding,
  type Harness,
  type HarnessDeps,
  type HarnessResume,
  type HarnessRun,
  type HarnessSession,
  type OpenCodeHarnessFacts,
} from "../contract.js";
import type { RunBearerStore } from "../../modelProxy/runBearers.js";
import type { WindDownEnding } from "../windDown.js";
import { OPENCODE_EVENT_DISPOSITION } from "./dispositions.js";
import {
  driveOpenCode,
  OpenCodeRequestRefusedError,
  OpenCodeWriteUnresolvedError,
  openCodeToolNameWord,
  StepBoundaries,
  type OpenCodeConnection,
  type OpenCodeReattach,
} from "./bridge.js";
import {
  openCodeAuthHeader,
  OPENCODE_ROUTES,
  OPENCODE_VERSION,
  openCodeSessionRoutes,
  parseHealth,
  parseAnswerId,
  parsePermissionList,
  readSessionStore,
  readStoreSince,
} from "./client.js";
import {
  launchOpenCode,
  openCodeBuiltinToolsFor,
  openCodeFacts,
  openCodeRunPaths,
  openCodeRunPathsAt,
  openCodeTailerEnv,
  OPENCODE_AGENT,
  TAILER_BIN,
  type OpenCodeCompactionConfig,
  type OpenCodeLaunchSpec,
  type OpenCodeRunPaths,
  type OpenCodeStarted,
} from "./process.js";
import { openCodeImportBody, openCodeSeedAndRequest, openCodeSessionId, openCodeSettlementNote } from "./session.js";
import { OPENCODE_TAILER_SOURCE } from "./tailerSource.js";
import { PROXY_PROVIDER } from "../pi/process.js";
import type { LiveHarness } from "../pi/relay.js";

/** What a deployment sets for every run on OpenCode: the compaction thresholds
 *  OpenCode's own words carry (`OpenCodeCompactionConfig`; harness.md item 12).
 *  Absent, OpenCode's defaults stand. `OpenCodeHarness` folds them in from its
 *  own settings, so the loop hands every harness the same `HarnessDeps`. */
export interface OpenCodeHarnessSettings {
  compaction?: OpenCodeCompactionConfig;
}

export class OpenCodeHarness implements Harness {
  readonly name = "opencode" as const;
  /** OpenCode accepts an imported session as its own history: a seed is
   *  that history written for it, a rebuild a rewrite of it. */
  readonly history = "authored-session" as const;
  readonly dispositions = OPENCODE_EVENT_DISPOSITION;

  constructor(private readonly settings: OpenCodeHarnessSettings = {}) {}

  /** Switchboard's effort tier in OpenCode's word: the tier selects a model
   *  `variant` on the session's model ref (item 11: variants are declared per
   *  model and a session selects one by id). Stage A's configuration writer
   *  declares no reasoning variants, so there is none to select and the tier is
   *  left to OpenCode's default — the honest answer until a deployment declares
   *  them (a follow-up to the configuration word). */
  effort(_tier: Effort | undefined): string | undefined {
    return undefined;
  }

  /** OpenCode's own tools a run of this identity holds — what the deny rules
   *  leave visible — in the record's shared vocabulary (`shell → bash`,
   *  `glob → find`), so the conformance table, which reads the record, sees the
   *  same words a tool call lands under and across harnesses. */
  builtinTools(identity: Identity): readonly string[] {
    return openCodeBuiltinToolsFor(identity).map(openCodeToolNameWord);
  }

  open(deps: HarnessDeps, run: HarnessRun): Promise<HarnessSession> {
    return openOpenCodeRun(deps, run, this.settings);
  }

  /** Where the row's OpenCode is (the survival clause), before any pid is
   *  probed: another harness's facts answer `another-harness` with no command;
   *  a row naming another container than this run was handed is
   *  `another-container` (a pid here is a stranger's); else the recorded port is
   *  probed — any HTTP answer (even the 401 the password-guarded health returns
   *  without the bearer, which `find` does not hold) means the server is up
   *  (`alive-here`), a connection that reaches no server means `dead`. A
   *  container gone under the probe is the typed error, as pi's `find` rethrows. */
  async find(facts: OpenCodeHarnessFacts | { harness: string }, container: HarnessContainer): Promise<Finding> {
    if (facts.harness !== "opencode") return "another-harness";
    const oc = facts as OpenCodeHarnessFacts;
    const here = await identityOrNothing(container);
    if (oc.container !== undefined && here !== undefined && oc.container !== here) return "another-container";
    try {
      const paths = openCodeRunPathsAt(oc.root);
      await container.request(paths, { method: "GET", port: oc.port, path: OPENCODE_ROUTES["health.get"].path });
      return "alive-here";
    } catch (err) {
      if (isContainerGone(err)) throw err;
      return "dead";
    }
  }

  /** End the OpenCode a previous generation left behind — the server and its
   *  tailer at the pids the facts name, the root removed — best-effort, like the
   *  session's end; another harness's facts are left alone. */
  async end(facts: OpenCodeHarnessFacts | { harness: string }, container: HarnessContainer): Promise<void> {
    if (facts.harness !== "opencode") return;
    const oc = facts as OpenCodeHarnessFacts;
    await container.kill(oc.pid).catch(() => {});
    if (oc.tailerPid !== undefined) await container.kill(oc.tailerPid).catch(() => {});
    await container.remove(openCodeRunPathsAt(oc.root)).catch(() => {});
  }
}

/** The model ref a session carries — on the create, the seed's import and a
 *  rebuild's import alike. The provider is the configuration's one provider,
 *  `PROXY_PROVIDER` (the key `openCodeConfig` writes the model under), never
 *  the bot's provider name (`run.model.provider`, `anthropic` on a live
 *  deployment): OpenCode resolves the ref against its configuration and a
 *  provider it does not define is `Model unavailable: <provider>/<id>`. The id
 *  is the run's, and the effort tier is its variant when the harness names
 *  one (none in stage A). */
function modelRef(run: HarnessRun, variant: string | undefined): { providerID: string; id: string; variant?: string } {
  return { providerID: PROXY_PROVIDER, id: run.model.id, ...(variant ? { variant } : {}) };
}

/** The feed's current end byte, read forward from `from` to the last byte: a
 *  post-turn's loop reads only what it appends and never re-processes the run
 *  loop's records; a re-attach reads the dead generation's records up to here
 *  as catch-up and this generation's own past it. */
async function feedEndFrom(container: HarnessContainer, feed: string, from: number): Promise<number> {
  let off = from;
  for (;;) {
    const chunk = await container.readLog(feed, off, LOG_READ_BYTES);
    off += chunk.length;
    if (chunk.length < LOG_READ_BYTES) return off;
  }
}

/** What `open` continues on, whichever way the server came to be: this
 *  generation's launch, or the dead generation's server re-attached. */
interface OpenCodeLive {
  pid: number;
  port: number;
  tailerPid: number;
  password: string;
  paths: OpenCodeRunPaths;
  sessionID: string;
  feedOffset: number;
  reattach?: OpenCodeReattach;
}

/** A resume's facts as OpenCode's, when the row carries them: `openThroughSeam`
 *  refuses another harness's row before `open`, so a resume here that names any
 *  harness names OpenCode's; the narrowing is the defence pi's `open` keeps. */
export function resumeOpenCodeFacts(resume: HarnessResume | undefined): OpenCodeHarnessFacts | undefined {
  const facts = resume?.facts;
  return facts !== undefined && facts.harness === "opencode" ? facts : undefined;
}

/** The run's OpenCode from the first file to the answer. */
export async function openOpenCodeRun(
  deps: HarnessDeps,
  run: HarnessRun,
  settings: OpenCodeHarnessSettings,
): Promise<HarnessSession> {
  const now = () => deps.clock();
  const emit = (event: RunEvent) => run.onEvent?.(event.at === undefined ? { ...event, at: now() } : event);
  const note = (kind: RunNoteKind, summary: string) => {
    run.onProgress?.(summary);
    emit({ type: "run_note", kind, summary });
  };
  const identity = run.agent.identity;

  // The run on the relay, so the plugin's `/harness/tools`, `/harness/authorize`
  // and `/harness/tool` posts answer — the gate on OpenCode's OWN tools rides
  // the bridge's `permission.asked`, so the LiveHarness's gate hooks are the
  // relay's own: it saw the call, nothing blocks it (the wind-down steers, it
  // never refuses a relayed tool), and its tool context is the run's, swapped
  // for a post-turn. The relay's spans are the bridge's, opened from the feed.
  // The bridge's wind-down reaches the relay's door: when `driveOpenCode` is
  // winding the run down (the time budget, the turn guard, a soft stop), a
  // relayed tool is refused at `/harness/authorize` the same as pi's are, so
  // no new work starts while the run writes its final answer. The bridge sets
  // this holder; the LiveHarness reads it.
  const writeUp: { blocked?: string } = {};
  const live: LiveHarness = {
    runId: run.runId,
    tools: run.tools,
    toolContext: run.toolContext,
    ...(run.backend ? { backend: run.backend } : {}),
    rules: { ...run.rules, identity },
    emit,
    toolSpan: () => undefined,
    gateSaw: () => {},
    toolsBlocked: () => writeUp.blocked,
    callSeen: async () => {},
    callEnded: async () => {},
  };
  const resumeFacts = resumeOpenCodeFacts(run.resume);
  const relaunch = run.resume?.relaunch !== undefined;
  // A relaunch under a living bot takes the run's registration over with its
  // relayed calls kept — the calls the bot still runs for the OpenCode that died
  // with its container; a fresh run or a resume after a bot death registers anew.
  const forget =
    relaunch && deps.registry.get(run.runId) !== undefined ? deps.registry.replace(live) : deps.registry.register(live);
  // A call in flight at the death is answered from the record if the relay is
  // asked again by its call id: the settlement note in the result's place, never
  // re-run. A call the relay still runs (a relaunch) keeps its running answer.
  const relayCalls = deps.registry.calls(run.runId);
  for (const s of run.resume?.settlements ?? [])
    relayCalls?.settle(s.toolUse.id, { content: [{ type: "text", text: openCodeSettlementNote(s) }], isError: true });

  const paths = openCodeRunPaths(run.runId);
  const spec: OpenCodeLaunchSpec = {
    runId: run.runId,
    paths,
    model: { id: run.model.id, providerType: run.model.providerType, maxTokens: run.agent.maxTokens },
    harnessUrl: deps.harnessUrl,
    identity,
    system: run.system,
    relayTools: run.tools.map((t) => t.name),
    ...(settings.compaction ? { compaction: settings.compaction } : {}),
  };

  // What the run continues on: the fresh launch, or the re-attached server.
  let server: OpenCodeLive | undefined;
  // The container was replaced under the run (the ceiling's verdict): the old
  // process is gone with the old container's disk, and a pid in the container
  // this run holds now is a stranger's, so `end` probes, ends and removes
  // nothing — the loop relaunches from the record instead.
  let replaced = false;
  // The container this run was handed, named once: the resume's placement, the
  // row's facts, and the replaced verdict's `was` all read it.
  const here = await deps.container.identity().catch(() => undefined);
  const budgetLeft = () => Math.round((run.resume?.remainingMs ?? 0) / 60_000);
  // The row's facts as this generation last wrote them: the launch's or the
  // re-attach's, then the feed offset following the ledger's steps.
  let facts: OpenCodeHarnessFacts | undefined;
  const saveFacts = (next: OpenCodeHarnessFacts) => {
    facts = next;
    run.saveFacts?.(next);
  };
  // The requests the loop posts and does not wait on (`OpenCodeConnection.posted`), joined by `end` after the kill that cuts the unanswered.
  const posted = new Set<Promise<unknown>>();
  // Every store message id this generation knows the server holds — the
  // import's, a re-attach's store, each loop's refills — so a loop can tell a
  // prompt of its own that landed from what was there before (the control
  // reset's resolution, `OpenCodeConnection.knownMessageIds`).
  const known = new Set<string>();
  // The import's rows among them: an imported row newest is an idle session (the
  // import writes no idle marker; measured, a steer there landed at once).
  const imported = new Set<string>();
  const end = async (): Promise<void> => {
    forget();
    if (replaced || server === undefined) return;
    await deps.container.kill(server.pid).catch(() => {});
    await deps.container.kill(server.tailerPid).catch(() => {});
    await deps.container.remove(server.paths).catch(() => {});
    // The requests the loop posted and did not wait on — an ending's
    // interrupt, a steer — have settled by now: answered while the server
    // lived (their word on the record, the run still open) or cut by the kill
    // above (silent). The run finishes after this returns, so no answer can
    // reach a finished record. Bounded by the executor's own command timeout
    // — the longest any of them can still take when the executor itself is
    // what stalled — never longer: past it the answer is one nobody waits on.
    await Promise.race([Promise.allSettled([...posted]), deps.sleep(OP_TIMEOUT_MS)]);
  };

  try {
    // A resume names the row's OpenCode before anything is started (the survival
    // clause). A relaunch under a living bot: its container was replaced, so the
    // row's process is gone with the old disk — nothing is probed or ended, the
    // registration is already taken over, and a fresh server is started on the
    // record. Otherwise a row naming another container is the orphan (neither
    // probed nor ended here); a row naming THIS container may still have its
    // server running on its recorded root, so it is probed: a server that
    // answers with the row's password is re-attached onto — the run continues
    // on the session it was driving — and one that answers but cannot be
    // re-attached is ended before a fresh launch that would otherwise collide
    // with it.
    if (relaunch) {
      const rl = run.resume?.relaunch;
      note(
        "resumed",
        `relaunched after the container was replaced (${rl?.from ?? "unknown"} → ${rl?.to ?? here ?? "unknown"}); a fresh server was started on the record with ${budgetLeft()} min of budget left`,
      );
    } else if (resumeFacts !== undefined) {
      const elsewhere = resumeFacts.container !== undefined && here !== undefined && resumeFacts.container !== here;
      if (elsewhere) {
        note(
          "resumed",
          `resumed after a restart: the row's OpenCode (pid ${resumeFacts.pid}) ran in container ${resumeFacts.container}, not the one this run was handed (${here}); it was neither probed nor ended here, and a fresh server was started on the record`,
        );
      } else {
        const health = await probeRecordedServer(deps.container, resumeFacts);
        if (health === "dead") {
          // The row's server is gone: its root on this container's disk, when it
          // is another than the fresh start's, goes with it (as a dead pi's does);
          // nothing is ended, since a pid that does not answer is nobody's here.
          if (resumeFacts.root !== paths.dir)
            await deps.container.remove(openCodeRunPathsAt(resumeFacts.root)).catch(() => {});
          note(
            "resumed",
            `resumed after a restart: the row's OpenCode did not answer in this container; a fresh server was started on the record with ${budgetLeft()} min of budget left`,
          );
        } else {
          const attempt = await reattachOpenCode(
            { container: deps.container, runId: run.runId, ...(deps.bearers ? { bearers: deps.bearers } : {}) },
            resumeFacts,
            health,
          );
          if (attempt.ok) {
            server = attempt.server;
            const inFlight = run.resume?.settlements.length ?? 0;
            const pendingAsks = attempt.server.reattach.pendingAsks.length;
            const calls =
              inFlight > 0
                ? ` — ${inFlight} call(s) were in flight, ` +
                  (pendingAsks > 0
                    ? `${pendingAsks} of them pending asks the gate decides, the rest answered with a restart note if OpenCode asks the relay for them again`
                    : "each answered with a restart note if OpenCode asks the relay for it again")
                : pendingAsks > 0
                  ? ` — ${pendingAsks} pending ask(s) on the server the gate decides`
                  : "";
            const tailer = attempt.tailerRestarted
              ? `; its tailer had died and was restarted on the same feed (pid ${server.tailerPid})`
              : "";
            note(
              "resumed",
              `resumed after a restart: OpenCode still runs in the container (pid ${server.pid}, port ${server.port}); continuing its session with ${budgetLeft()} min of budget left${calls}${tailer}`,
            );
            // The row learns the tailer it continues with, the feed byte this
            // generation caught up to, and the container it was found in when
            // the row did not say; the relaunch count is the loop's, carried.
            saveFacts({
              ...resumeFacts,
              tailerPid: server.tailerPid,
              logOffset: attempt.server.reattach.catchUpTo,
              ...(here !== undefined ? { container: here } : {}),
            });
          } else {
            // The row's server answers here but cannot be continued: end it and
            // its tailer and remove its root before a fresh launch, so no second
            // server writes the same feed and no orphaned plugin keeps posting
            // under the run id.
            note(
              "resumed",
              `resumed after a restart: the row's OpenCode (pid ${resumeFacts.pid}) still answers in this container but could not be re-attached (${attempt.why}); ended it and its tailer before a fresh start on the record with ${budgetLeft()} min of budget left`,
            );
            await deps.container.kill(resumeFacts.pid).catch(() => {});
            if (resumeFacts.tailerPid !== undefined) await deps.container.kill(resumeFacts.tailerPid).catch(() => {});
            await deps.container.remove(openCodeRunPathsAt(resumeFacts.root)).catch(() => {});
          }
        }
      }
    }

    if (server === undefined) {
      const started = await launchOpenCode(
        {
          container: deps.container,
          clock: deps.clock,
          sleep: deps.sleep,
          ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
        },
        spec,
        deps.bearer,
      );
      server = { ...started, sessionID: openCodeSessionId(run.runId) };
      const auth = { Authorization: openCodeAuthHeader(started.password) };
      const at = now();
      const cwd = deps.container.cwd(started.paths, run.rules.checkout);

      // The session: a resume imports the record; a fresh run with a seed imports
      // the earlier turns; a fresh run of one turn is created with none. An
      // answer outside 2xx to either is the run's failure by name, said on the
      // record first: the prime is the request that would carry a model
      // reference OpenCode cannot resolve.
      const refusedBy = (what: string, res: HarnessResponse): OpenCodeRequestRefusedError => {
        const refused = new OpenCodeRequestRefusedError(what, res.status, res.body);
        note("harness_error", `${refused.message} — the run is stopped`);
        return refused;
      };
      const importInto = async (
        messages: Parameters<typeof openCodeImportBody>[0],
        opts: Parameters<typeof openCodeImportBody>[1],
      ) => {
        const body = openCodeImportBody(messages, opts);
        // Measured against the pinned binary: the import keeps the ids the body
        // carries (a 260-message import listed back under its own ids), so the
        // body's ids are the server's — known before the answer comes.
        for (const m of body.messages)
          if (typeof m.id === "string") {
            known.add(m.id);
            imported.add(m.id);
          }
        const res = await request(deps.container, started, auth, OPENCODE_ROUTES["session.import"], body);
        if (res.status < 200 || res.status >= 300) throw refusedBy("session import", res);
      };
      if (run.resume !== undefined && run.resume.messages.length > 0) {
        const settlements = new Map(run.resume.settlements.map((s) => [s.toolUse.id, openCodeSettlementNote(s)]));
        await importInto(run.resume.messages, {
          sessionID: server.sessionID,
          location: { directory: cwd },
          model: modelRef(run, undefined),
          agent: OPENCODE_AGENT,
          at,
          ...(run.resume.compactions ? { compactions: run.resume.compactions.map((c) => c.entry) } : {}),
          settlements,
        });
      } else {
        const { seed } = openCodeSeedAndRequest(run.messages);
        if (seed.length > 0) {
          await importInto(seed, {
            sessionID: server.sessionID,
            location: { directory: cwd },
            model: modelRef(run, undefined),
            agent: OPENCODE_AGENT,
            at,
          });
        } else {
          const res = await request(deps.container, started, auth, OPENCODE_ROUTES["session.create"], {
            id: server.sessionID,
            agent: OPENCODE_AGENT,
            location: { directory: cwd },
            model: modelRef(run, undefined),
          });
          if (res.status < 200 || res.status >= 300) throw refusedBy("session create", res);
          const created = parseAnswerId(res.body);
          if (created !== undefined) server.sessionID = created;
        }
      }

      // The row's facts: the launch's pid/port/root and the session, the bearer's
      // hash (never the bearer), the container's word, and the loop's relaunch
      // count carried through (0 on a fresh run).
      saveFacts(
        openCodeFacts(
          { pid: started.pid, port: started.port, paths: started.paths, tailerPid: started.tailerPid },
          {
            sessionID: server.sessionID,
            logOffset: started.feedOffset,
            bearer: deps.bearer,
            ...(here !== undefined ? { container: here } : {}),
            relaunches: resumeFacts?.relaunches ?? 0,
          },
        ),
      );
    }

    for (const m of server.reattach?.store ?? []) known.add(m.id);
    const conn: OpenCodeConnection = {
      container: deps.container,
      posted,
      knownMessageIds: known,
      writes: { seq: 0, ownPrompts: new Map<string, number>(), imported },
      boundaries: new StepBoundaries(),
      failure: {},
      paths: server.paths,
      port: server.port,
      password: server.password,
      sessionID: server.sessionID,
      feedOffset: server.feedOffset,
      pid: server.pid,
      tailerPid: server.tailerPid,
      ...(here !== undefined ? { containerWord: here } : {}),
      writeUp,
      // The row's offset follows the ledger: the feed byte after each refill
      // whose steps landed, so the next generation reads on from there.
      saveOffset: (logOffset) => {
        if (facts !== undefined && logOffset > facts.logOffset) saveFacts({ ...facts, logOffset });
      },
      ...(server.reattach ? { reattach: server.reattach } : {}),
    };

    // The thread's follow-ups, steered into the running session as they arrive
    // (`prompt { delivery: "steer" }`), each an `input` event and a `follow_up`
    // note on the record; the drainer runs beside the loop and stops when it
    // settles. `driveOpenCode` owns the wind-down and the hard stop.
    let draining = true;
    // The drainer's own failure — a follow-up's steer the store could not
    // resolve — is held for the loop's end (a rejection with no one waiting on
    // it would be unhandled), then thrown once the loop has left — unless the
    // loop ended on the operator's hard stop, which wins: the run ends as the
    // stop, the failure staying on the record as the drainer's `harness_error`.
    const drainer = drainFollowUps(deps, run, conn, () => draining, emit, note).then(
      () => undefined,
      (err: unknown) => err,
    );

    let answer: string;
    let ending: WindDownEnding | undefined;
    let remainingMs: () => number;
    let hardStopped: boolean;
    let drained: unknown;
    try {
      let storeIds: string[];
      ({ answer, ending, remainingMs, storeIds, hardStopped } = await driveOpenCode(deps, run, conn));
      for (const id of storeIds) known.add(id);
    } finally {
      draining = false;
      drained = await drainer;
    }
    if (drained instanceof OpenCodeWriteUnresolvedError && !hardStopped) throw drained;

    return {
      answer,
      ...(ending ? { ending } : {}),
      followUp: async (input) => {
        // One more turn on the same session (the post-turns: the coding
        // description, the review's verdict), driven through the same loop over
        // a connection that reads only what the turn appends. The relayed
        // tools read the turn's own context for its duration.
        const turnEnd = await feedEndFrom(deps.container, conn.paths.feed, conn.feedOffset);
        const previous = live.toolContext;
        live.toolContext = input.toolContext;
        // The turn's lease is carved from the run's: the lesser of its ask and
        // what the lease still holds, never under a minute (decision 0046).
        const turnMinutes = turnLeaseMs(input.maxMinutes, remainingMs()) / MINUTE_MS;
        // The turn's tools, marked for the proxy for the turn's duration (model-proxy item 6).
        deps.bearers?.markTurn(run.runId, input.tools);
        try {
          const turn = await driveOpenCode(
            deps,
            {
              ...run,
              messages: [{ role: "user", content: [{ type: "text", text: input.text }] }],
              agent: { ...run.agent, maxTurns: input.maxTurns, maxMinutes: turnMinutes },
              toolContext: input.toolContext,
              ...(input.span ? { span: input.span } : {}),
              resume: undefined,
              inbox: undefined,
              // The post-turn is not mirrored to the ledger — the loop's
              // transcript is the record — but the bridge needs a step sink to
              // read the answer, so a discard stands in.
              onStep: async () => {},
            },
            { ...conn, feedOffset: turnEnd, saveOffset: undefined, reattach: undefined, knownMessageIds: known },
            "turn",
          );
          for (const id of turn.storeIds) known.add(id);
          return turn.answer;
        } finally {
          deps.bearers?.clearTurn(run.runId);
          live.toolContext = previous;
        }
      },
      remainingMs,
      end,
    };
  } catch (err) {
    // The container was replaced under the run: nothing of the old process is
    // in the container that answers now, so `end` probes, ends and removes
    // nothing there — the loop relaunches from the record the verdict carries.
    if (err instanceof HarnessContainerReplacedError) replaced = true;
    await end();
    throw err;
  }
}

/** The row's server probed on its recorded port in this container — with the
 *  row's password when the row carries a bearer hash (the answer then doubles
 *  as the password check the re-attach needs), without one otherwise: any
 *  HTTP answer means the server is up; a connection that reaches no server
 *  means it is gone. A container gone under the probe is the typed error,
 *  rethrown, never read as gone. */
async function probeRecordedServer(
  container: HarnessContainer,
  facts: OpenCodeHarnessFacts,
): Promise<HarnessResponse | "dead"> {
  try {
    return await container.request(openCodeRunPathsAt(facts.root), {
      method: "GET",
      port: facts.port,
      path: OPENCODE_ROUTES["health.get"].path,
      ...(facts.bearerHash !== undefined
        ? { secretHeaders: { Authorization: openCodeAuthHeader(facts.bearerHash) } }
        : {}),
    });
  } catch (err) {
    if (isContainerGone(err)) throw err;
    return "dead";
  }
}

/** How many store pages a re-attach reads back at most, and how many messages each carries (the route's cap). */

type ReattachAttempt =
  | { ok: true; server: OpenCodeLive & { reattach: OpenCodeReattach }; tailerRestarted: boolean }
  | { ok: false; why: string };

/** The re-attach onto the row's server, or why it cannot be done, by name.
 *  Nothing is changed until every check passes: the row's `bearerHash` is the
 *  server's password (`openCodePassword` derived it from the bearer, so a row
 *  without one names a server whose password nobody here can derive); the
 *  health answered with it must be the pin's version; this generation's proxy
 *  adopts the bearer the server keeps presenting (a store that refuses names a
 *  grant gone or expired); the session's store is read back whole, page by
 *  page, and its pending asks listed (a session the server refuses is not
 *  continued); the feed is readable from the row's offset and no shorter than
 *  it (a shorter feed was truncated, and reading on from the offset would skip
 *  everything the tailer writes until it grows past it). Then the tailer: kept
 *  where its pid still answers, else restarted over the same feed with
 *  `keepLog`, so the recorded offset still points into what it points into.
 *  The continue's delivery follows the store's tail: an `idle` marker last
 *  means no execution runs and the prompt is queued to start one; anything
 *  else means one is under way — blocked on an ask, inside a relayed call, or
 *  between steps — and the prompt is steered in at its next step boundary,
 *  where a queued one would wait for that execution to end and then start a
 *  second turn the loop, having settled on the first, would never read. */
async function reattachOpenCode(
  deps: { container: HarnessContainer; runId: string; bearers?: RunBearerStore },
  facts: OpenCodeHarnessFacts,
  health: HarnessResponse,
): Promise<ReattachAttempt> {
  const refuse = (why: string): ReattachAttempt => ({ ok: false, why });
  const password = facts.bearerHash;
  if (password === undefined)
    return refuse("the row carries no bearer hash, so the server's password cannot be derived");
  if (health.status === 401) return refuse("the server refused the run's password");
  if (health.status !== 200) return refuse(`the health answered ${health.status}`);
  const parsed = parseHealth(health.body);
  if (parsed === undefined) return refuse("the health answered something that is not the health shape");
  if (parsed.version !== OPENCODE_VERSION)
    return refuse(`the server is opencode ${parsed.version}; this build drives ${OPENCODE_VERSION}`);

  const paths = openCodeRunPathsAt(facts.root);
  const auth = { Authorization: openCodeAuthHeader(password) };
  const get = (path: string): Promise<HarnessResponse> =>
    deps.container.request(paths, { method: "GET", port: facts.port, path, secretHeaders: auth });
  const routes = openCodeSessionRoutes(facts.sessionID);
  const read = await readSessionStore(get, facts.sessionID);
  if (!read.ok) return refuse(read.why);
  const store = read.messages;
  const pending = await get(routes["session.permission.list"].path);
  if (pending.status < 200 || pending.status >= 300)
    return refuse(`the server refused the session's pending asks (${pending.status})`);
  const pendingAsks = parsePermissionList(pending.body);
  if (pendingAsks === undefined) return refuse("the pending asks answered something that is not the list shape");

  let catchUpTo: number;
  try {
    if (facts.logOffset > 0) {
      const before = await deps.container.readLog(paths.feed, facts.logOffset - 1, 1);
      if (before.length === 0)
        return refuse(`the feed is shorter than the row's offset (${facts.logOffset}): it was truncated`);
    }
    catchUpTo = await feedEndFrom(deps.container, paths.feed, facts.logOffset);
  } catch (err) {
    if (isContainerGone(err)) throw err;
    return refuse(
      `the feed could not be read from byte ${facts.logOffset} (${redactAndCap(err instanceof Error ? err.message : String(err), 200)})`,
    );
  }

  // Every check has passed: the bearer the server keeps presenting joins this
  // generation's proxy now and not before, so a re-attach refused above leaves
  // the dead generation's hash refused at the proxy (a store that refuses names
  // a grant gone or expired). The tailer's restart, the one side effect, follows.
  if (deps.bearers !== undefined && !deps.bearers.adopt(deps.runId, password))
    return refuse("this generation's proxy could not adopt the row's bearer (the run's grant is gone or expired)");

  let tailerPid = facts.tailerPid;
  let tailerRestarted = false;
  if (tailerPid === undefined || !(await deps.container.alive(tailerPid))) {
    await deps.container.writeFile(paths.tailerScript, OPENCODE_TAILER_SOURCE);
    const tailer = await deps.container.start({
      paths: paths.tailer,
      command: TAILER_BIN,
      args: [paths.tailerScript],
      env: openCodeTailerEnv(password, facts.pid),
      port: facts.port,
      keepLog: true,
    });
    tailerPid = tailer.pid;
    tailerRestarted = true;
  }

  const last = store.at(-1);
  return {
    ok: true,
    tailerRestarted,
    server: {
      pid: facts.pid,
      port: facts.port,
      tailerPid,
      password,
      paths,
      sessionID: facts.sessionID,
      feedOffset: facts.logOffset,
      reattach: {
        store,
        pendingAsks,
        catchUpTo,
        delivery: last === undefined || last.type === "idle" ? "queue" : "steer",
      },
    },
  };
}

/** The follow-up drainer: while the loop runs, drain the inbox on the loop's
 *  tick, stage any files, record each follow-up on the run's stream, and steer
 *  it into the session. */
function drainFollowUps(
  deps: HarnessDeps,
  run: HarnessRun,
  conn: OpenCodeConnection,
  running: () => boolean,
  emit: (event: RunEvent) => void,
  note: (kind: RunNoteKind, summary: string) => void,
): Promise<void> {
  const auth = { Authorization: openCodeAuthHeader(conn.password) };
  const routes = openCodeSessionRoutes(conn.sessionID);
  return (async () => {
    /** The follow-ups the store told lost, and behind each the same person's
     *  later ones as they come — the rest of its batch, later drains' — in
     *  order: never steered again by this loop, requeued to the front of the
     *  inbox once the loop has left, for the run stage's fresh-turn path. */
    const deferred: FollowUpInput[] = [];
    /** Whose follow-up: the person's, or a parent run's steer (thread-admission item 7). */
    const senderOf = (input: FollowUpInput): string =>
      input.from !== undefined ? `run:${input.from.runId}` : `user:${input.userId}`;
    while (running()) {
      const inputs = run.inbox?.drain() ?? [];
      for (const input of inputs) {
        // Once a person's follow-up is held for the fresh turn, that person's
        // later ones are held behind it, in order: the model never reads a
        // person's later follow-up before an earlier one, and the fresh turn
        // carries them in order. Another sender's still goes out: nothing of
        // theirs is waiting. A parent run's steer is never held — a program's
        // steer gets no fresh turn (the settlement sets it aside, thread-
        // admission item 7), so one waiting behind a lost one would never be
        // read; a lost one is handed back and noted as any lost steer is.
        if (input.from === undefined && deferred.some((held) => senderOf(held) === senderOf(input))) {
          deferred.push(input);
          note(
            "follow_up",
            `follow-up held for a fresh turn behind an earlier one from the same sender the server did not take: ${redactSecrets(followUpSnippet(input))}`,
          );
          continue;
        }
        let stagedLine = "";
        if (run.stageFollowUps) {
          try {
            stagedLine = await run.stageFollowUps([input]);
          } catch (err) {
            stagedLine = `Attached files could not be staged: ${err instanceof Error ? err.message : String(err)}`;
            note("follow_up", `staging the follow-up's files failed: ${redactSecrets(stagedLine)}`);
          }
        }
        const prompt = followUpPrompt([input]);
        const text = stagedLine ? `${prompt}\n\n${stagedLine}` : prompt;
        // The steer is the delivery: the record says a follow-up was folded in
        // only once the server admitted it. A steer the server never took (the
        // request threw, or it answered outside 2xx) is said on the record as
        // undelivered and handed back to the inbox — it and the rest of this
        // batch — for the run stage's fresh-turn path (thread-admission item
        // 4), never recorded as read and lost; the drainer stops here, since a
        // server that refuses a steer is one the loop itself is about to find
        // gone, and a retry every tick would only repeat the note.
        let failure: string | undefined;
        /** The store's word that the server took nothing: held for the fresh turn with the batch behind it (`deferred`), never steered again by this loop; no refusal. */
        let lost = false;
        // The steer joins the connection's `posted` set — the loop's own reads
        // (`promptLanded`) wait on it before reading the store — until it has
        // answered and, when the answer named no id or the reset cut it, until
        // the store has been read once for the verdict: so a steer's row of the
        // prompt's own text is known before the loop reads, and no longer. Its
        // wait on a step boundary runs outside the set: the boundary comes only
        // from the loop's own feed reading, which a loop waiting on this steer
        // would never do — a circular wait with no bound on either side. A
        // write the control plane's reset left unknown is thus resolved once
        // this steer has answered — and its answer names the user message it
        // became (measured), known from here: a steer's row of the prompt's
        // own text is never read as the prompt landed. An answer that names
        // none, or a control reset that cut the answer, is told from the store
        // instead — the one verdict for both, since a server that answered and
        // recorded nothing is a steer lost as much as one the reset cut: the
        // rows newer than what was known when the steer was posted (never what
        // was learned since — the loop's own prompt after it, the rows of an
        // execution it started), newest first, a user row of the steer's text
        // being the steer landed (measured: an idle session's steer has its
        // row in the store at once) — its id learned, the follow-up delivered;
        // none, and the session idle when the steer was posted — nothing newer
        // than the loop's own prompts posted AFTER the steer (the session's
        // writes are counted in order, `conn.writes`), and below the oldest of
        // them the idle marker, an imported row or nothing at all — the steer
        // lost, handed back. None, with an execution under way at the steer
        // (anything else newest below the later prompts) — the ordinary
        // timing, a follow-up arriving mid-step — the store cannot yet say: a
        // steer into a running execution lands only at its next step boundary
        // (measured), so the verdict waits for the boundaries the loop reads
        // off its feed (`conn.boundaries`: a step's end or failure, the
        // execution's end, the idle) and the store is read again at each — the
        // row there, landed; the idle marker newest since the steer with no
        // row, lost. The store's word decides, never a count of boundaries —
        // and a follow-up told lost is never steered again by this loop, since
        // a steer told lost while the server still held it would reach the
        // model twice once its row landed: it is held with the batch behind it
        // for the run stage's fresh turn. Measured against the real binary: a
        // steer into a running execution is announced `session.inbox.enqueued`
        // at its POST and `session.inbox.delivered` at the step boundary it
        // lands at, right after that step's `session.step.ended`, its row in
        // the store there — before the execution's terminal event, the
        // execution running a step for it — and a steer arriving after the end
        // starts a new execution at once, its row in the store before the
        // answer; a steer enqueued when the execution is interrupted is
        // dropped with it (no `session.inbox.delivered`, no row, no new
        // execution), and one enqueued when the execution fails is delivered
        // into a new execution the server starts at once; so the idle marker
        // newest since the steer with no row, read after any terminal
        // transition, is the server's word that it took nothing.
        // The loop leaving the feed with no row and the store still showing the
        // execution under way (a hung tool the finale interrupts) is the steer
        // unresolved. Unresolved — that, or a store that cannot be read —
        // fails the run by name as the loop's own writes do, one rule: the
        // loop ended through the connection (`conn.failure`, no stop asked of
        // the run's control) and the harness throwing once it has left, the
        // follow-up and the batch's not yet posted handed back with it — never
        // a landed steer steered again by this loop, never a follow-up dropped.
        const learnRow = async (
          steerSeq: number,
          knownAtSteer: ReadonlySet<string>,
        ): Promise<"landed" | "lost" | "running"> => {
          const known = conn.knownMessageIds ?? new Set<string>();
          const read = await readStoreSince(
            (path) => conn.container.request(conn.paths, { method: "GET", port: conn.port, path, secretHeaders: auth }),
            conn.sessionID,
            knownAtSteer,
          ).catch((err: unknown): { ok: false; why: string } => ({
            ok: false,
            why: `the store could not be listed: ${redactAndCap(err instanceof Error ? err.message : String(err), 200)}`,
          }));
          if (!read.ok) throw new OpenCodeWriteUnresolvedError("the follow-up's steer", read.why);
          // The rows newer than what was known at the steer, newest first; the
          // OLDEST prompt of the loop's own posted after this steer, and
          // everything above it, set aside.
          let later = -1;
          for (let i = read.messages.length - 1; i >= 0 && later === -1; i--)
            if ((conn.writes?.ownPrompts.get(read.messages[i].id) ?? -1) > steerSeq) later = i;
          const since = later === -1 ? read.messages : read.messages.slice(later + 1);
          const rows = since.filter((m) => m.type === "user" && (m as { text?: unknown }).text === text);
          for (const row of rows) known.add(row.id);
          if (rows.length > 0) return "landed";
          const atSteer = since[0] ?? read.stopped;
          if (atSteer === undefined || atSteer.type === "idle" || conn.writes?.imported.has(atSteer.id) === true)
            return "lost";
          return "running";
        };
        /** Landed (`true`) or lost (`false`) — the store's word — waiting on the feed's step boundaries while the store shows an execution under way; `waiting` is told once before the first wait, when the store has been read and the verdict now depends on the loop. */
        const resolve = async (
          steerSeq: number,
          knownAtSteer: ReadonlySet<string>,
          seen: number,
          waiting: () => void,
        ): Promise<boolean> => {
          let left = false;
          for (;;) {
            const verdict = await learnRow(steerSeq, knownAtSteer);
            if (verdict !== "running") return verdict === "landed";
            if (conn.boundaries === undefined)
              throw new OpenCodeWriteUnresolvedError(
                "the follow-up's steer",
                "an execution is under way and this connection reads no step boundaries off the loop's feed, so the store cannot yet say whether the server took it",
              );
            if (left)
              throw new OpenCodeWriteUnresolvedError(
                "the follow-up's steer",
                "the loop left the feed with no row of the steer and the store still showing its execution under way, so the store cannot say whether the server took it",
              );
            waiting();
            if ((await conn.boundaries.wait(seen)) === "left") left = true;
            seen = conn.boundaries.count;
          }
        };
        // What the loop's reads wait on: settled once the steer has answered
        // and any store read its verdict needs has run once (see above).
        let readOnce: () => void = () => undefined;
        const posted = new Promise<void>((settle) => (readOnce = settle));
        conn.posted?.add(posted);
        const sent = (async () => {
          // What the store held, and the boundaries the loop had read, when the
          // steer was posted. The copy is bounded by the session's store — the
          // rows the loop has learned, thousands at most — and made once per
          // follow-up, cheaper than the store read it bounds.
          const knownAtSteer: ReadonlySet<string> = new Set(conn.knownMessageIds ?? []);
          const seenAtSteer = conn.boundaries?.count ?? 0;
          const steerSeq = conn.writes ? ++conn.writes.seq : 0;
          try {
            const res = await conn.container.request(conn.paths, {
              method: routes["session.prompt"].method,
              port: conn.port,
              path: routes["session.prompt"].path,
              secretHeaders: auth,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text, delivery: "steer" }),
            });
            if (res.status < 200 || res.status >= 300) failure = `the server answered ${res.status}`;
            else {
              const id = parseAnswerId(res.body);
              if (id !== undefined) conn.knownMessageIds?.add(id);
              else if (!(await resolve(steerSeq, knownAtSteer, seenAtSteer, readOnce))) {
                lost = true;
                failure = "the server answered with no message id and the store holds no row of the steer";
              }
            }
          } catch (err) {
            // A steer the store cannot resolve fails the run by name (below), never a hand-back.
            if (err instanceof OpenCodeWriteUnresolvedError) throw err;
            failure = err instanceof Error ? err.message : String(err);
            if (isControlReset(err)) {
              if (await resolve(steerSeq, knownAtSteer, seenAtSteer, readOnce)) failure = undefined;
              else lost = true;
            }
          } finally {
            readOnce();
            conn.posted?.delete(posted);
          }
        })();
        try {
          await sent;
        } catch (err) {
          if (err instanceof OpenCodeWriteUnresolvedError) {
            note("harness_error", `${err.message} — the run is stopped`);
            // The loop ends by the failure's name through the connection — no
            // stop is asked of the run's control, so the record carries no
            // `stopped` note, the sandbox is released as after any named
            // failure and the dispatcher's settlement, seeing no stop, hands
            // the follow-ups handed back below on for the fresh turn.
            conn.failure.error = err;
            // The follow-ups held for the fresh turn, this one, and the batch's
            // after it, never posted: back to the inbox for the run stage's
            // fresh-turn path, never dropped. This one may have reached the
            // server — but the run fails by name here and its session is over,
            // so a row the server took reaches no model call now; the fresh
            // turn repeating it is the record's word kept, the harness_error
            // above naming the steer.
            run.inbox?.requeue([...deferred.splice(0), ...inputs.slice(inputs.indexOf(input))]);
          }
          throw err;
        }
        if (failure !== undefined) {
          note(
            "follow_up",
            `follow-up not delivered — the steer did not reach the session (${redactAndCap(failure, 200)}); handed back to the inbox for a fresh turn: ${redactSecrets(followUpSnippet(input))}`,
          );
          const rest = inputs.slice(inputs.indexOf(input));
          // A steer the server refused — the request threw, or answered outside
          // 2xx — is one the loop itself is about to find gone: everything
          // held and everything behind goes back to the inbox now, and the
          // drainer stops here (a retry every tick would only repeat the note).
          if (!lost) {
            run.inbox?.requeue([...deferred.splice(0), ...rest]);
            return;
          }
          // A steer the store told lost is no refusal — the server took
          // nothing — but it is never steered again by this loop: were the
          // server still holding it, a second steer would reach the model
          // twice. It is held for the run stage's fresh turn, and the same
          // sender's later follow-ups — the rest of this batch and later drains'
          // — are held behind it (above), so that sender's order holds across
          // the fresh turn; another sender's follow-ups go on being steered.
          deferred.push(input);
          continue;
        }
        const source = {
          ...(input.sourceUrl ? { url: input.sourceUrl } : {}),
          ...(input.userName ? { user: input.userName } : {}),
          ...(input.from ? { run: input.from.runId } : {}),
        };
        emit({
          type: "input",
          text: redactSecrets(input.text),
          messageId: followUpMessageId(input),
          ...(Object.keys(source).length > 0 ? { source } : {}),
        });
        note("follow_up", `follow-up folded in: ${redactSecrets(followUpSnippet(input))}`);
      }
      if (!running()) break;
      await deps.sleep(deps.tickMs ?? 1000);
    }
    // The loop has left: what the store told lost, with the batches behind it,
    // to the front of the inbox in order for the run stage's fresh-turn path.
    if (deferred.length > 0) run.inbox?.requeue(deferred.splice(0));
  })();
}

/** One request into the server, with the password as a secret header. */
function request(
  container: HarnessContainer,
  started: OpenCodeStarted,
  auth: Record<string, string>,
  route: { method: string; path: string },
  body?: unknown,
): Promise<HarnessResponse> {
  return container.request(started.paths, {
    method: route.method,
    port: started.port,
    path: route.path,
    secretHeaders: auth,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}
