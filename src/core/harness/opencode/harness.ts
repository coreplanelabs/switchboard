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
// the record and the budgets are `driveOpenCode`'s. A resume rebuilds from the
// record: the ledger's transcript imported into a fresh store with the
// settlement of any call in flight, and a `resumed` note where the row's
// process is elsewhere or gone. The relaunch ceiling under a living bot (a
// container replaced mid-run, the bearer rotated, at most twice) is the
// OpenCode half of the survival clause the run loop drives; this module builds
// the rebuild path `open` takes with a resume, so that loop can call it.

import type { Identity } from "../../../agents/registry.js";
import type { Effort } from "../../../effort.js";
import { followUpMessageId, followUpPrompt, followUpSnippet } from "../../threadAdmission.js";
import { redactAndCap, redactSecrets, type RunEvent, type RunNoteKind } from "../../runEvents.js";
import { isContainerGone, LOG_READ_BYTES, type HarnessContainer, type HarnessResponse } from "../container.js";
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
import { OPENCODE_EVENT_DISPOSITION } from "./dispositions.js";
import { driveOpenCode, openCodeToolNameWord, type OpenCodeConnection } from "./bridge.js";
import { openCodeAuthHeader, OPENCODE_ROUTES, openCodeSessionRoutes } from "./client.js";
import {
  launchOpenCode,
  openCodeBuiltinToolsFor,
  openCodeFacts,
  openCodeRunPaths,
  openCodeRunPathsAt,
  OPENCODE_AGENT,
  type OpenCodeCompactionConfig,
  type OpenCodeLaunchSpec,
  type OpenCodeStarted,
} from "./process.js";
import { openCodeImportBody, openCodeSeedAndRequest, openCodeSessionId, openCodeSettlementNote } from "./session.js";
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
    const here = await container.identity();
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

/** The model ref a session carries: the run's provider and model, and the
 *  effort tier as its variant when the harness names one (none in stage A). */
function modelRef(run: HarnessRun, variant: string | undefined): { providerID: string; id: string; variant?: string } {
  return { providerID: run.model.provider, id: run.model.id, ...(variant ? { variant } : {}) };
}

/** The whole feed's current end byte: read from the run's start offset to the
 *  last byte, so a post-turn's loop reads only what it appends and never
 *  re-processes the run loop's records. */
async function feedEnd(container: HarnessContainer, conn: OpenCodeConnection): Promise<number> {
  let off = conn.feedOffset;
  for (;;) {
    const chunk = await container.readLog(conn.paths.feed, off, LOG_READ_BYTES);
    off += chunk.length;
    if (chunk.length < LOG_READ_BYTES) return off;
  }
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

  let started: OpenCodeStarted | undefined;
  // The container was replaced under the run (the ceiling's verdict): the old
  // process is gone with the old container's disk, and a pid in the container
  // this run holds now is a stranger's, so `end` probes, ends and removes
  // nothing — the loop relaunches from the record instead.
  let replaced = false;
  // The container this run was handed, named once: the resume's placement, the
  // row's facts, and the replaced verdict's `was` all read it.
  const here = await deps.container.identity().catch(() => undefined);
  const end = async (): Promise<void> => {
    forget();
    if (replaced || started === undefined) return;
    await deps.container.kill(started.pid).catch(() => {});
    await deps.container.kill(started.tailerPid).catch(() => {});
    await deps.container.remove(started.paths).catch(() => {});
  };

  try {
    // A resume names the row's OpenCode before anything is started (the survival
    // clause). A relaunch under a living bot: its container was replaced, so the
    // row's process is gone with the old disk — nothing is probed or ended, the
    // registration is already taken over, and a fresh server is started on the
    // record. Otherwise a row naming another container is the orphan (neither
    // probed nor ended here); a row naming THIS container may still have its
    // server running on the deterministic root, so it is probed and ended before
    // a fresh launch that would otherwise collide with a live one.
    if (relaunch) {
      const rl = run.resume?.relaunch;
      note(
        "resumed",
        `relaunched after the container was replaced (${rl?.from ?? "unknown"} → ${rl?.to ?? here ?? "unknown"}); a fresh server was started on the record with ${Math.round((run.resume?.remainingMs ?? 0) / 60_000)} min of budget left`,
      );
    } else if (resumeFacts !== undefined) {
      const elsewhere = resumeFacts.container !== undefined && here !== undefined && resumeFacts.container !== here;
      if (elsewhere) {
        note(
          "resumed",
          `resumed after a restart: the row's OpenCode (pid ${resumeFacts.pid}) ran in container ${resumeFacts.container}, not the one this run was handed (${here}); it was neither probed nor ended here, and a fresh server was started on the record`,
        );
      } else if (await serverAnswers(deps.container, resumeFacts)) {
        // The row's server still answers on the recorded port here: end it and
        // its tailer and remove its root before a fresh launch, so no second
        // server writes the same feed and no orphaned plugin keeps posting under
        // the run id. (A full re-attach — the row's password from its bearer
        // hash, the tailer kept, the feed from its offset — is the follow-up.)
        note(
          "resumed",
          `resumed after a restart: the row's OpenCode (pid ${resumeFacts.pid}) still answers in this container; ended it and its tailer before a fresh start on the record`,
        );
        await deps.container.kill(resumeFacts.pid).catch(() => {});
        if (resumeFacts.tailerPid !== undefined) await deps.container.kill(resumeFacts.tailerPid).catch(() => {});
        await deps.container.remove(openCodeRunPathsAt(resumeFacts.root)).catch(() => {});
      } else {
        // The row's server is gone: its root on this container's disk, when it
        // is another than the fresh start's, goes with it (as a dead pi's does);
        // nothing is ended, since a pid that does not answer is nobody's here.
        if (resumeFacts.root !== paths.dir)
          await deps.container.remove(openCodeRunPathsAt(resumeFacts.root)).catch(() => {});
        note(
          "resumed",
          `resumed after a restart: the row's OpenCode did not answer in this container; a fresh server was started on the record with ${Math.round((run.resume?.remainingMs ?? 0) / 60_000)} min of budget left`,
        );
      }
    }

    started = await launchOpenCode(
      {
        container: deps.container,
        clock: deps.clock,
        sleep: deps.sleep,
        ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
      },
      spec,
      deps.bearer,
    );
    const auth = { Authorization: openCodeAuthHeader(started.password) };
    const at = now();
    const cwd = deps.container.cwd(started.paths, run.rules.checkout);

    // The session: a resume imports the record; a fresh run with a seed imports
    // the earlier turns; a fresh run of one turn is created with none.
    let sessionID: string;
    const importInto = async (
      messages: Parameters<typeof openCodeImportBody>[0],
      opts: Parameters<typeof openCodeImportBody>[1],
    ) => {
      const body = openCodeImportBody(messages, opts);
      const res = await request(deps.container, started!, auth, OPENCODE_ROUTES["session.import"], body);
      if (res.status < 200 || res.status >= 300)
        throw new Error(`OpenCode refused the session import (${res.status}): ${redactAndCap(res.body, 200)}`);
    };
    if (run.resume !== undefined && run.resume.messages.length > 0) {
      sessionID = openCodeSessionId(run.runId);
      const settlements = new Map(run.resume.settlements.map((s) => [s.toolUse.id, openCodeSettlementNote(s)]));
      await importInto(run.resume.messages, {
        sessionID,
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
        sessionID = openCodeSessionId(run.runId);
        await importInto(seed, {
          sessionID,
          location: { directory: cwd },
          model: modelRef(run, undefined),
          agent: OPENCODE_AGENT,
          at,
        });
      } else {
        sessionID = openCodeSessionId(run.runId);
        const res = await request(deps.container, started, auth, OPENCODE_ROUTES["session.create"], {
          id: sessionID,
          agent: OPENCODE_AGENT,
          location: { directory: cwd },
          model: modelRef(run, undefined),
        });
        if (res.status < 200 || res.status >= 300)
          throw new Error(`OpenCode refused the session create (${res.status}): ${redactAndCap(res.body, 200)}`);
        const created = parseSessionId(res.body);
        if (created !== undefined) sessionID = created;
      }
    }

    const conn: OpenCodeConnection = {
      container: deps.container,
      paths: started.paths,
      port: started.port,
      password: started.password,
      sessionID,
      feedOffset: started.feedOffset,
      tailerPid: started.tailerPid,
      ...(here !== undefined ? { containerWord: here } : {}),
      writeUp,
    };

    // The row's facts: the launch's pid/port/root and the session, the bearer's
    // hash (never the bearer), the container's word, and the loop's relaunch
    // count carried through (0 on a fresh run).
    run.saveFacts?.(
      openCodeFacts(
        { pid: started.pid, port: started.port, paths: started.paths, tailerPid: started.tailerPid },
        {
          sessionID,
          logOffset: started.feedOffset,
          bearer: deps.bearer,
          ...(here !== undefined ? { container: here } : {}),
          relaunches: resumeFacts?.relaunches ?? 0,
        },
      ),
    );

    // The thread's follow-ups, steered into the running session as they arrive
    // (`prompt { delivery: "steer" }`), each an `input` event and a `follow_up`
    // note on the record; the drainer runs beside the loop and stops when it
    // settles. `driveOpenCode` owns the wind-down and the hard stop.
    let draining = true;
    const drainer = drainFollowUps(deps, run, conn, () => draining, emit, note);

    let answer: string;
    try {
      ({ answer } = await driveOpenCode(deps, run, conn));
    } finally {
      draining = false;
      await drainer.catch(() => {});
    }

    return {
      answer,
      followUp: async (input) => {
        // One more turn on the same session (the post-turns: the coding
        // description, the review's verdict), driven through the same loop over
        // a connection that reads only what the turn appends. The relayed
        // tools read the turn's own context for its duration.
        const turnEnd = await feedEnd(deps.container, conn);
        const previous = live.toolContext;
        live.toolContext = input.toolContext;
        try {
          const { answer: turnAnswer } = await driveOpenCode(
            deps,
            {
              ...run,
              messages: [{ role: "user", content: [{ type: "text", text: input.text }] }],
              agent: { ...run.agent, maxTurns: input.maxTurns, maxMinutes: input.maxMinutes },
              toolContext: input.toolContext,
              ...(input.span ? { span: input.span } : {}),
              resume: undefined,
              inbox: undefined,
              // The post-turn is not mirrored to the ledger — the loop's
              // transcript is the record — but the bridge needs a step sink to
              // read the answer, so a discard stands in.
              onStep: async () => {},
            },
            { ...conn, feedOffset: turnEnd },
          );
          return turnAnswer;
        } finally {
          live.toolContext = previous;
        }
      },
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

/** Whether the row's OpenCode still answers on the recorded port in this
 *  container: any HTTP answer — even the 401 the password-guarded health
 *  returns without the bearer — means the server is up; a connection that
 *  reaches no server means it is gone. A container gone under the probe is the
 *  typed error, rethrown, never read as gone. */
async function serverAnswers(container: HarnessContainer, facts: OpenCodeHarnessFacts): Promise<boolean> {
  try {
    await container.request(openCodeRunPathsAt(facts.root), {
      method: "GET",
      port: facts.port,
      path: OPENCODE_ROUTES["health.get"].path,
    });
    return true;
  } catch (err) {
    if (isContainerGone(err)) throw err;
    return false;
  }
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
    while (running()) {
      const inputs = run.inbox?.drain() ?? [];
      for (const input of inputs) {
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
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
        }
        if (failure !== undefined) {
          note(
            "follow_up",
            `follow-up not delivered — the steer did not reach the session (${redactAndCap(failure, 200)}); handed back to the inbox for a fresh turn: ${redactSecrets(followUpSnippet(input))}`,
          );
          run.inbox?.requeue(inputs.slice(inputs.indexOf(input)));
          return;
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

/** The session id a create answered, or nothing for a body of another shape. */
function parseSessionId(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as { data?: { id?: unknown } };
    return typeof value.data?.id === "string" ? value.data.id : undefined;
  } catch {
    return undefined;
  }
}
