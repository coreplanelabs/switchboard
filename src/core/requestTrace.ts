import type { ConfigStore } from "../config.js";
import type { RunEvent } from "./runEvents.js";
import type { Channel, SpanAttrs } from "./trace/attrs.js";
import { createCardSink, type SetupCard } from "./trace/cardSink.js";
import { displayNameOf } from "./trace/displayNames.js";
import { createLogSink, NULL_SINK } from "./trace/sinks.js";
import { createRunStreamSink } from "./trace/runStreamSink.js";
import { isStreamed } from "./trace/streamSpans.js";
import { createTracer } from "./trace/tracer.js";
import { systemClock } from "./trace/clock.js";
import type { Clock, Span, SpanRecord, SpanSink, Tracer } from "./trace/types.js";
import type { SpanLog } from "./trace/spanLog.js";

// One request, one root (features/tracing.md, Sink scoping). `startRequestRoot`
// is the constructor of request roots: the channel adapters call it at receipt
// and the dispatcher's fresh turn at its own start, and hand the result to
// `dispatch()`. The root's sinks, in order: the process log sink (or the
// injected sinks — a test's recording sink), the run-stream sink (a Null
// Object until `bindRun` points it at a registry run), the card sink (a Null
// Object until `bindCard`), and a collector that keeps every record so far,
// so a card closed before any run existed can still print the request's shape.
// `startProcessRoot` is the other constructor: a root for the bot's own work
// outside any request (item 20) — the reconnect catch-up pass, the drain, a
// deploy step — with the leading sinks only, since nothing streams or paints.

export interface RequestTrace {
  /** The request's root span; `dispatch()` ends it in its outermost finally. */
  readonly root: Span;
  /** Our process saw the message: the root's start, the window's opening. */
  readonly receivedAt: number;
  /** Point the run-stream sink at a registry run: backfill, then route live. */
  bindRun(runId: string, publish: (event: RunEvent) => void): void;
  /** Point the card sink at the status card: setup labels paint from here. */
  bindCard(card: SetupCard): void;
  /** Every span under the root so far — ended ones complete, started ones
   *  open — for a shape computed at a paint. */
  spansSoFar(): SpanRecord[];
}

export interface RequestTraceDeps {
  /** The config store, for `tracing.log`; a caller without one logs no spans. */
  config?: Pick<ConfigStore, "config">;
  /** The wall clock; `systemClock` in production, a ticking clock in tests. */
  clock?: Clock;
  /** The tracer; injected by the no-gaps test for its `SpanContext`. */
  tracer?: Tracer;
  /** The root's leading sinks; defaults to the one log sink at `tracing.log`. */
  sinks?: SpanSink[];
  /** The in-process span log (features/tracing.md item 26): joins the leading sinks whenever they are not injected. */
  spanLog?: SpanLog;
}

export interface RequestRootOptions {
  channel: Channel | undefined;
  receivedAt: number;
  attrs?: SpanAttrs;
}

/** The root's leading sinks: the injected ones (a test's recording sink), else
 *  the one log sink at `tracing.log` (else nothing) plus the process's span
 *  log when it has one — every span end, at every level, readable in-process. */
function leadingSinks(deps: RequestTraceDeps): SpanSink[] {
  if (deps.sinks) return deps.sinks;
  const level = deps.config?.config.tracing?.log;
  return [
    level ? createLogSink({ level, write: (line) => console.log(line) }) : NULL_SINK,
    ...(deps.spanLog ? [deps.spanLog.sink] : []),
  ];
}

export function startRequestRoot(deps: RequestTraceDeps, opts: RequestRootOptions): RequestTrace {
  const clock = deps.clock ?? systemClock;
  const tracer = deps.tracer ?? createTracer({ clock });
  const stream = createRunStreamSink({ clock });
  const card = createCardSink((name) => `${displayNameOf(name)}…`);
  const records = new Map<string, SpanRecord>();
  const collector: SpanSink = {
    onStart: (rec) => void records.set(rec.spanId, rec),
    onEnd: (rec) => void records.set(rec.spanId, rec),
  };
  const root = tracer.start("request", {
    sinks: [...leadingSinks(deps), stream, card, collector],
    startedAt: opts.receivedAt,
    attrs: { ...(opts.channel ? { channel: opts.channel } : {}), ...(opts.attrs ?? {}) },
  });
  return {
    root,
    receivedAt: opts.receivedAt,
    bindRun(runId, publish) {
      root.setAttrs({ runId });
      stream.bindRun(runId, (e) => publish(e as RunEvent));
    },
    bindCard(c) {
      card.bindCard(c);
    },
    spansSoFar() {
      // The root itself is structure, never a term; streamed children only —
      // the partition is over what a run's stream would carry.
      return [...records.values()].filter((r) => r.spanId !== root.id && isStreamed(r.name));
    },
  };
}

/** The roots the bot starts for its own work, outside any request. */
export type ProcessRootName = "slack.catch_up" | "drain" | `deploy.step.${string}`;

export interface ProcessRootOptions {
  attrs?: SpanAttrs;
  startedAt?: number;
}

/** A root for work no request caused (features/tracing.md item 20): the
 *  reconnect catch-up pass, the drain, one deploy step. Leading sinks only —
 *  it streams to no run and paints no card — so under `tracing.log: roots` it
 *  is one JSON line when it ends, its facts in `attrs`. The caller ends it. */
export function startProcessRoot(deps: RequestTraceDeps, name: ProcessRootName, opts: ProcessRootOptions = {}): Span {
  const clock = deps.clock ?? systemClock;
  const tracer = deps.tracer ?? createTracer({ clock });
  return tracer.start(name, {
    sinks: leadingSinks(deps),
    ...(opts.startedAt !== undefined ? { startedAt: opts.startedAt } : {}),
    ...(opts.attrs ? { attrs: opts.attrs } : {}),
  });
}

/** Run `fn` under a process root: ended `ok` when it returns, failed (the
 *  classification or the redacted message) and ended `error` when it throws —
 *  the throw still propagates. `fn` sets the root's attrs as it learns them. */
export async function withProcessRoot<T>(
  deps: RequestTraceDeps,
  name: ProcessRootName,
  fn: (root: Span) => Promise<T>,
  opts: ProcessRootOptions = {},
): Promise<T> {
  const root = startProcessRoot(deps, name, opts);
  try {
    const value = await fn(root);
    root.end("ok");
    return value;
  } catch (err) {
    root.fail(err);
    root.end("error");
    throw err;
  }
}

/** The channel a message came from, read off its namespaced channel id
 *  (`slack:C…`, `http:…`, `mcp:…`, `cli:…`); anything else names no channel. */
export function channelOf(channelId: string): Channel | undefined {
  const prefix = channelId.slice(0, channelId.indexOf(":"));
  return prefix === "slack" || prefix === "http" || prefix === "mcp" || prefix === "cli" ? prefix : undefined;
}
