// The intake replay and the live false-silence ratio (docs/reference/specs/load-harness.md
// item 20; docs/decisions/0058). Two measurements share this module:
//   - `load -- intake --fixtures <path>` replays a labelled file of
//     unmentioned thread replies through `decideIntake` — the production
//     verdict, the router's own `RouteModel` seam, no ledger — and scores the
//     verdicts against the labels: the false-silence rate over the addressed
//     replies and the false-answer rate over the silent ones, each with its
//     Wilson interval (the sets are small, so a bare rate would overclaim),
//     the abstention shares, and the model ref the calls ran on. The labelled
//     file lives outside the repository under `load-results/` (real people's
//     words are forbidden in the tree); the checked-in synthetic set
//     (`intakeFixtures.ts`) runs this scoring in CI over a scripted model.
//   - `load -- intake --live` reads the ledger's `silent` receipts
//     (`listIntake`) and joins each to its thread's later messages: a receipt
//     counts recovered when the same person mentions the bot in the thread
//     within the recovery window — the ignored person's recovery move — and
//     the ratio recovered/silent, per week, is the live gate the offline set
//     cannot be.
// Pure over its seams: the model, the ledger and the replies reader are
// handed in; nothing here reads a clock or the network.
import { INTAKE_RECOVERY_WINDOW_MS, MINUTE_MS } from "../core/budgets.js";
import type { RouteModel } from "../core/dispatch/route.js";
import {
  INTAKE_ANSWERS,
  decideIntake,
  type IntakeSource,
  type IntakeVerdict,
  type IntakeTurn,
} from "../core/intake.js";
import type { IntakeReceipt } from "../core/runLedger/types.js";
import { wilsonInterval } from "./aggregate.js";
import type { IntakeFixture } from "./intakeFixtures.js";

/** One replayed reply: the fixture beside the verdict the model reached. */
export interface IntakeReplayResult extends IntakeFixture {
  verdict: IntakeVerdict;
  source: IntakeSource;
  reason: string;
  /** Wall time of the intake call, ms. */
  ms: number;
}

export interface IntakeReplayOpts {
  /** The `<provider>/<model>` ref the calls run on — printed, never parsed. */
  modelRef: string;
  now: () => number;
  concurrency?: number;
  /** The call's bound; default the router's, as production runs it. */
  timeoutMs?: number;
}

/**
 * Replay each labelled reply through `decideIntake` — the production verdict
 * path with no ledger, so every row is decided fresh — `concurrency` at a
 * time, results in fixture order, each call timed. Fail-closed outcomes (a
 * timeout, a provider error, a malformed answer) are verdicts like any other:
 * they are silences, and the score counts them as such.
 */
export async function replayIntake(
  fixtures: readonly IntakeFixture[],
  model: RouteModel,
  opts: IntakeReplayOpts,
): Promise<IntakeReplayResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const results: IntakeReplayResult[] = new Array<IntakeReplayResult>(fixtures.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= fixtures.length) return;
      const f = fixtures[i];
      const started = opts.now();
      const decision = await decideIntake(
        {
          // The key is inert here: the replay runs with no ledger, so no
          // receipt is read or written under it.
          key: `${f.threadKey}#${f.id}`,
          threadKey: f.threadKey,
          mode: "classify",
          model: opts.modelRef,
          gen: 0,
          message: f.message,
          turns: f.turns,
          facts: f.facts,
        },
        {
          model,
          ledger: null,
          now: opts.now,
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        },
      );
      results[i] = {
        ...f,
        verdict: decision.verdict,
        source: decision.source,
        reason: decision.reason,
        ms: Math.max(0, opts.now() - started),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, fixtures.length) }, worker));
  return results;
}

/** The replay's score: the two conditional rates — each quoted with the
 *  Wilson bounds at its `n` (NaN rate and bounds over `n = 0` — the rendering
 *  states the missing denominator instead) — the abstention shares' counts
 *  over all replies, and every miss with its coordinates. */
export interface IntakeScore {
  total: number;
  /** Over the replies labelled `addressed`: the verdicts that fell silent. */
  addressed: { n: number; falseSilence: number; rate: number; interval: { low: number; high: number } };
  /** Over the replies labelled `silent`: the verdicts that answered. */
  silent: { n: number; falseAnswer: number; rate: number; interval: { low: number; high: number } };
  /** The model answered `unsure` (failed closed to silent by contract). */
  unsure: number;
  /** The call timed out (failed closed to silent). */
  timeouts: number;
  /** The call or the parse failed (failed closed to silent). */
  errors: number;
  misses: Array<{
    id: string;
    stratum: string;
    label: IntakeFixture["label"];
    verdict: IntakeVerdict;
    source: IntakeSource;
    reason: string;
  }>;
}

/** An `unsure` answer as `parseIntakeAnswer` records it: verdict `silent`,
 *  source `model`, the reason prefixed `unsure:` — the one place the
 *  abstention is still visible on the decision. */
function isUnsure(r: Pick<IntakeReplayResult, "source" | "reason">): boolean {
  return r.source === "model" && r.reason.startsWith("unsure:");
}

export function intakeScore(results: readonly IntakeReplayResult[]): IntakeScore {
  const addressed = results.filter((r) => r.label === "addressed");
  const silent = results.filter((r) => r.label === "silent");
  const falseSilence = addressed.filter((r) => r.verdict === "silent").length;
  const falseAnswer = silent.filter((r) => r.verdict === "addressed").length;
  return {
    total: results.length,
    addressed: {
      n: addressed.length,
      falseSilence,
      rate: falseSilence / addressed.length,
      interval: wilsonInterval(falseSilence, addressed.length),
    },
    silent: {
      n: silent.length,
      falseAnswer,
      rate: falseAnswer / silent.length,
      interval: wilsonInterval(falseAnswer, silent.length),
    },
    unsure: results.filter(isUnsure).length,
    timeouts: results.filter((r) => r.source === "timeout").length,
    errors: results.filter((r) => r.source === "error").length,
    misses: results
      .filter((r) => r.verdict !== r.label)
      .map((r) => ({
        id: r.id,
        stratum: r.stratum,
        label: r.label,
        verdict: r.verdict,
        source: r.source,
        reason: r.reason,
      })),
  };
}

const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 1000) / 10}%` : "—");

/** A rate line: `k/n = 20% (95% CI 3.6%–62.4%)`, or the stated
 *  no-denominator sentence over `n = 0` — never NaN on the receipt. */
function rateLine(
  name: string,
  over: string,
  wrong: number,
  n: number,
  interval: { low: number; high: number },
): string {
  if (n === 0) return `no ${over} in the set — the ${name} has no denominator`;
  return `${name} over ${n} ${over}: ${wrong}/${n} = ${pct(wrong / n)} (95% CI ${pct(interval.low)}–${pct(interval.high)})`;
}

/** The score as the receipt's notes: the model ref line, the two rates, the
 *  abstention shares and every miss. */
export function renderIntake(score: IntakeScore, opts: { modelRef: string }): string[] {
  const lines = [
    `model: ${opts.modelRef}`,
    rateLine(
      "false-silence rate",
      "addressed replies",
      score.addressed.falseSilence,
      score.addressed.n,
      score.addressed.interval,
    ),
    rateLine("false-answer rate", "silent replies", score.silent.falseAnswer, score.silent.n, score.silent.interval),
    `abstentions (each failed closed to silent): unsure ${score.unsure}/${score.total} (${pct(score.unsure / Math.max(1, score.total))}), timeout ${score.timeouts}/${score.total} (${pct(score.timeouts / Math.max(1, score.total))}), error ${score.errors}/${score.total} (${pct(score.errors / Math.max(1, score.total))})`,
  ];
  if (score.misses.length === 0) lines.push("misses: none");
  else {
    lines.push(`misses (${score.misses.length}):`);
    for (const m of score.misses)
      lines.push(`- ${m.id} [${m.stratum}] labelled ${m.label}, verdict ${m.verdict} (${m.source}): ${m.reason}`);
  }
  return lines;
}

/** One line of the labelled file: a JSON object of the fixture shape. The
 *  validator names what is wrong; the parser names the line. */
function isIntakeFixture(v: unknown): v is IntakeFixture {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  const turns = Array.isArray(f.turns)
    ? (f.turns as unknown[]).every((t) => {
        const turn = t as Partial<IntakeTurn>;
        return (
          typeof t === "object" &&
          t !== null &&
          (turn.role === "bot" || turn.role === "requester" || turn.role === "person") &&
          typeof turn.text === "string"
        );
      })
    : false;
  const facts = f.facts as Record<string, unknown> | undefined;
  return (
    typeof f.id === "string" &&
    f.id.length > 0 &&
    typeof f.stratum === "string" &&
    (f.label === "addressed" || f.label === "silent") &&
    typeof f.message === "string" &&
    turns &&
    typeof facts === "object" &&
    facts !== null &&
    typeof facts.replierIsRequester === "boolean" &&
    typeof facts.mentionsOther === "boolean" &&
    typeof facts.threadStartedByBot === "boolean" &&
    typeof f.threadKey === "string" &&
    f.threadKey.length > 0
  );
}

/** Parse a labelled file: one JSON reply per line, blank lines skipped, a
 *  malformed row refused naming its line — a silently dropped row would move
 *  the rates. The checked-in synthetic set round-trips through this format. */
export function parseIntakeFixtures(text: string): IntakeFixture[] {
  const fixtures: IntakeFixture[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`intake fixtures line ${i + 1}: not a JSON object`);
    }
    if (!isIntakeFixture(row))
      throw new Error(
        `intake fixtures line ${i + 1}: not a labelled reply (id, stratum, label ${INTAKE_ANSWERS.slice(0, 2).join("|")}, message, turns, facts, threadKey)`,
      );
    fixtures.push(row);
  }
  return fixtures;
}

/** What the live join asks of the ledger — `listIntake` alone. The run ledger
 *  implements it; tests hand a double. */
export interface LiveIntakeLedger {
  listIntake(query: { since?: number }): Promise<IntakeReceipt[]>;
}

/** One message of a thread as the replies reader hands it back (the Slack
 *  `conversations.replies` shape's three fields the join reads). */
export interface ThreadMessage {
  ts: string;
  user?: string;
  text?: string;
}

/** Reads a thread's messages, oldest first: the op backs it with the Slack
 *  Web API; tests hand a map. */
export type ThreadRepliesReader = (channel: string, threadTs: string) => Promise<ThreadMessage[]>;

/** One week of the ratio, keyed by its UTC Monday. */
export interface LiveIntakeWeek {
  start: string;
  silent: number;
  recovered: number;
}

/** The live ratio: recovered over silent, per week, with the receipts the
 *  join could not read counted apart — they stay in the denominator (the
 *  ratio is over ALL silent receipts) but are named on the report. */
export interface LiveIntakeRatio {
  silent: number;
  recovered: number;
  windowMs: number;
  weeks: LiveIntakeWeek[];
  skipped: { unparsedThread: number; readFailed: number; replyNotFound: number };
}

/** A Slack numeric ts as epoch milliseconds. */
function tsMs(ts: string): number {
  return Math.round(Number.parseFloat(ts) * 1000);
}

/** The UTC Monday of the instant's week, as a date string. */
function weekStartOf(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

/**
 * The live false-silence ratio: every `silent` receipt in the window, counted
 * recovered when the same person's later mention of the bot lands in the
 * thread within `windowMs` of the silenced reply. The silenced reply is the
 * thread's newest non-bot message at or before the receipt's decision — the
 * receipt carries the thread and the instant, not the message — and each
 * thread is read once however many receipts it holds.
 */
export async function liveFalseSilence(
  ledger: LiveIntakeLedger,
  replies: ThreadRepliesReader,
  opts: { botUserId: string; since?: number; windowMs?: number },
): Promise<LiveIntakeRatio> {
  const windowMs = opts.windowMs ?? INTAKE_RECOVERY_WINDOW_MS;
  const receipts = await ledger.listIntake(opts.since !== undefined ? { since: opts.since } : {});
  const silentRows = receipts.filter((r) => r.verdict === "silent");
  const skipped = { unparsedThread: 0, readFailed: 0, replyNotFound: 0 };
  const weeks = new Map<string, LiveIntakeWeek>();
  const threadCache = new Map<string, ThreadMessage[] | undefined>();
  let recovered = 0;
  for (const row of silentRows) {
    const week = weeks.get(weekStartOf(row.decidedAt)) ?? {
      start: weekStartOf(row.decidedAt),
      silent: 0,
      recovered: 0,
    };
    week.silent++;
    weeks.set(week.start, week);
    const parsed = /^slack:([^:]+):(.+)$/.exec(row.threadKey);
    if (!parsed) {
      skipped.unparsedThread++;
      continue;
    }
    if (!threadCache.has(row.threadKey)) {
      try {
        threadCache.set(row.threadKey, await replies(parsed[1], parsed[2]));
      } catch {
        threadCache.set(row.threadKey, undefined);
      }
    }
    const messages = threadCache.get(row.threadKey);
    if (messages === undefined) {
      skipped.readFailed++;
      continue;
    }
    // The silenced reply: the newest message at or before the decision that a
    // person (not the bot) posted — the verdict was decided right after it.
    const reply = [...messages]
      .filter((m) => m.user !== undefined && m.user !== opts.botUserId && tsMs(m.ts) <= row.decidedAt)
      .sort((a, b) => tsMs(a.ts) - tsMs(b.ts))
      .pop();
    if (!reply) {
      skipped.replyNotFound++;
      continue;
    }
    const mention = `<@${opts.botUserId}>`;
    const wasRecovered = messages.some(
      (m) =>
        m.user === reply.user &&
        tsMs(m.ts) > tsMs(reply.ts) &&
        tsMs(m.ts) - tsMs(reply.ts) <= windowMs &&
        (m.text ?? "").includes(mention),
    );
    if (wasRecovered) {
      recovered++;
      week.recovered++;
    }
  }
  return {
    silent: silentRows.length,
    recovered,
    windowMs,
    weeks: [...weeks.values()].sort((a, b) => a.start.localeCompare(b.start)),
    skipped,
  };
}

/** The ratio as printed lines: zero over zero stated as such, the window
 *  named in minutes, one line per week, the unjoinable receipts named. */
export function renderLiveIntake(ratio: LiveIntakeRatio): string[] {
  const minutes = Math.round(ratio.windowMs / MINUTE_MS);
  if (ratio.silent === 0)
    return ["live false-silence ratio: 0/0 — no silent receipts in the window, so the ratio says nothing yet"];
  const lines = [
    `live false-silence ratio: ${ratio.recovered}/${ratio.silent} (${pct(ratio.recovered / ratio.silent)}) — silent receipts followed by the same person's mention of the bot in the thread within ${minutes} minutes`,
  ];
  for (const w of ratio.weeks)
    lines.push(`week of ${w.start}: ${w.recovered}/${w.silent} (${pct(w.recovered / w.silent)})`);
  const { unparsedThread, readFailed, replyNotFound } = ratio.skipped;
  if (unparsedThread + readFailed + replyNotFound > 0)
    lines.push(
      `unjoinable (kept in the denominator, never counted recovered): ${unparsedThread} thread key(s) not a slack thread's, ${readFailed} thread read(s) failed, ${replyNotFound} silenced repl(ies) not found in the thread`,
    );
  return lines;
}
