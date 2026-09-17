// The run-scoped bearer (docs/reference/specs/model-proxy.md): the credential a
// run's harness presents to the bot's model proxy in place of a provider key.
// One is minted when a run's executor is provisioned, bound to the run's id,
// expiring at the run's wall-clock budget plus a margin, and revoked the moment
// the run ends — so a bearer authorizes exactly one run's model calls and no
// call after them. The store is in-process: a bot restart drops every bearer,
// which is the right answer (the run that held it is being resumed by a new
// generation, which mints its own) — with one exception: a pi that outlived
// the bot still holds the bearer the previous generation revealed to it, so
// the run's ledger row carries that bearer's secret HASH and the generation
// that re-attaches adopts it onto the run's fresh entry (`adopt`;
// docs/reference/specs/harness-pi.md item 8). A process relaunched under a
// living bot gets a new secret on the same entry instead (`rotate`): the meter
// stays the run's, and every earlier secret stops buying calls once the row
// carries the new one. Nothing here logs, and a token never appears in a
// message: `verify` answers a reason, never the material.
//
// The token names its run — `sbr_<runId>.<secret>` — so the proxy can tell an
// unknown run (404) from a wrong secret for a known one (401) without a second
// lookup, and the secret is compared in constant time. The store keeps the
// SHA-256 of every secret, never the secret: what a row may carry to name a
// bearer is the same hash, which buys nothing on its own.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ProviderConfig } from "../provider.js";
import type { RunEvent } from "../runEvents.js";
import type { Clock, Span } from "../trace/types.js";
import { bearerExpiresAt } from "../budgets.js";

export const BEARER_PREFIX = "sbr_";
const SECRET_BYTES = 32;

/** What a bearer buys: one run's model calls, pinned to the preset's model and
 *  caps, metered as that run's turns on the span the mint hands over. */
export interface RunBearerGrant {
  runId: string;
  /** `<provider>/<model>` as `run_meta` carries it — the `model.turn` span's `model` attr. */
  modelRef: string;
  /** The `providers:` entry the call is forwarded to, and its wire shape. */
  providerName: string;
  providerType: ProviderConfig["type"];
  /** The bare model id the wire carries, whatever the request named. */
  model: string;
  /** The per-call output cap and the turn cap, the preset's. */
  maxTokens: number;
  maxTurns: number;
  /** Absolute. The mint sets it provisionally (`provisionalBearerExpiresAt`:
   *  the provisioning allowance, the lease and the grace); the harness
   *  replaces it when the lease starts (`leaseStarted`: the lease's end plus
   *  the grace, docs/reference/specs/model-proxy.md item 2). */
  expiresAt: number;
  /** The span every proxied `model.turn` hangs under: the request root today;
   *  the harness bridge's `run.agent` once a harness drives the run. */
  span: Span;
  /** The run's stream — where a refusal's `run_note` lands. */
  publish: (event: RunEvent) => void;
}

export type BearerRefusal = "malformed" | "unknown_run" | "unknown_bearer" | "expired" | "revoked";

export type BearerVerdict =
  | { ok: true; grant: RunBearerGrant; turns: number }
  | { ok: false; reason: "malformed" }
  | { ok: false; reason: Exclude<BearerRefusal, "malformed">; runId: string };

/** One more turn, or why not: the run ended (revoked, or never minted here), or its budget is spent. */
export type TurnVerdict =
  | { ok: true; turn: number }
  | { ok: false; reason: "ended" }
  | { ok: false; reason: "budget"; turns: number; maxTurns: number };

/** How a rotation ended: the run's new bearer on its unchanged expiry, or the
 *  refusal by name — a run this store never minted, one that ended, one past
 *  its expiry (the runs `issue` mints nothing for). */
export type RotateVerdict =
  { ok: true; token: string; expiresAt: number } | { ok: false; reason: "unknown_run" | "revoked" | "expired" };

/** A run's grant as an operator may read it: the caps, the turns so far, how
 *  many secrets buy its calls, whether it ended — never a secret. */
export type RunBearerFacts = Omit<RunBearerGrant, "span" | "publish"> & {
  turns: number;
  /** The secrets that verify for the run right now: the mint's, plus one per
   *  `issue` and `adopt`; exactly one after a `rotate` completes. */
  bearers: number;
  revoked: boolean;
};

interface Entry {
  grant: RunBearerGrant;
  /** The SHA-256 of every secret that buys this run's calls: the provision's
   *  mint, an operator's `issue`, and a previous generation's bearer a pi
   *  still holds (`adopt`). Never the secrets themselves. */
  hashes: Buffer[];
  turns: number;
  revoked: boolean;
  /** The harness's marks for the proxy (docs/reference/specs/model-proxy.md
   *  item 6; decision 0046's amendment): the loop has ended, so the next
   *  request is the checkpoint turn and goes upstream with `tool_choice:
   *  none`; and, while set, a follow-up turn on the session with the tools it
   *  may call (`null`: the session's whole table), which lifts the none and
   *  trims the upstream list. Same entry as the bearer, so a rotation or an
   *  adopt keeps them. */
  marks: RunMarks;
}

/** What the proxy reads before it shapes a request's tools (model-proxy item 6). */
export interface RunMarks {
  loopEnded: boolean;
  turn?: { tools: readonly string[] | null };
}

export interface RunBearerStoreOptions {
  clock: Clock;
}

export class RunBearerStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly opts: RunBearerStoreOptions) {}

  /** The run's first bearer. A second mint for the same run replaces the
   *  entry — the earlier bearers stop verifying — so a resumed run under a new
   *  attach never leaves a stale credential valid. Sweeps expired entries first. */
  mint(grant: RunBearerGrant): string {
    this.sweep();
    const secret = randomBytes(SECRET_BYTES);
    this.entries.set(grant.runId, {
      grant,
      hashes: [hashOf(secret)],
      turns: 0,
      revoked: false,
      marks: { loopEnded: false },
    });
    return token(grant.runId, secret);
  }

  /** The loop has ended (the harness steers the write-up): the requests that
   *  follow are the checkpoint turn and go upstream with `tool_choice: none`
   *  until a turn is marked. False for a run this store never minted or one that ended. */
  markLoopEnded(runId: string): boolean {
    const entry = this.entries.get(runId);
    if (!entry || entry.revoked) return false;
    entry.marks = { ...entry.marks, loopEnded: true };
    return true;
  }

  /** A follow-up turn on the session is under way (harness-pi item 14): with
   *  `tools`, the upstream list is trimmed to them and the choice left to the
   *  model; without, the session's whole table stands. Lifts the checkpoint's
   *  none for the turn's duration. False for an unknown or ended run. */
  markTurn(runId: string, tools?: readonly string[]): boolean {
    const entry = this.entries.get(runId);
    if (!entry || entry.revoked) return false;
    entry.marks = { ...entry.marks, turn: { tools: tools === undefined ? null : [...tools] } };
    return true;
  }

  /** The follow-up turn ended: back to the loop-ended state. False for an unknown or ended run. */
  clearTurn(runId: string): boolean {
    const entry = this.entries.get(runId);
    if (!entry || entry.revoked) return false;
    const { turn: _turn, ...rest } = entry.marks;
    entry.marks = rest;
    return true;
  }

  /** The marks the proxy shapes a request by; nothing for a run this store never minted. */
  marksOf(runId: string): RunMarks | undefined {
    const entry = this.entries.get(runId);
    if (!entry) return undefined;
    return {
      loopEnded: entry.marks.loopEnded,
      ...(entry.marks.turn ? { turn: { tools: entry.marks.turn.tools } } : {}),
    };
  }

  /** The run's lease has started (the harness set its deadline): the bearer
   *  now expires at the lease's end plus the grace, replacing the mint's
   *  provisional expiry — so the grace is measured from the lease, not from
   *  the attach. False for a run this store never minted or one that ended. */
  leaseStarted(runId: string, leaseEndsAt: number): boolean {
    const entry = this.entries.get(runId);
    if (!entry || entry.revoked) return false;
    entry.grant = { ...entry.grant, expiresAt: bearerExpiresAt(leaseEndsAt) };
    return true;
  }

  /** Another bearer for a run still live: the same entry, expiry and turn
   *  counter (an operator's probe spends the run's own turns). Nothing for a
   *  run this store never minted, one that ended, or one past its expiry. */
  issue(runId: string): { token: string; expiresAt: number } | undefined {
    const entry = this.entries.get(runId);
    if (!entry || entry.revoked || this.opts.clock() >= entry.grant.expiresAt) return undefined;
    const secret = randomBytes(SECRET_BYTES);
    entry.hashes.push(hashOf(secret));
    return { token: token(runId, secret), expiresAt: entry.grant.expiresAt };
  }

  /** A bearer another generation minted for this run and a pi still holds
   *  (docs/reference/specs/harness-pi.md item 8): its secret's hash, as the
   *  run's row carried it, joins the run's live entry — the one this
   *  generation minted before re-attaching — so the calls that pi makes with
   *  it verify here under this generation's grant and turn counter. Nothing
   *  for a run this store never minted, one that ended, one past its expiry
   *  (as `issue`), or a hash of another shape; the hash itself buys no call. */
  adopt(runId: string, secretHash: string): boolean {
    const entry = this.entries.get(runId);
    if (!entry || entry.revoked || this.opts.clock() >= entry.grant.expiresAt) return false;
    if (!/^[0-9a-f]{64}$/.test(secretHash)) return false;
    entry.hashes.push(Buffer.from(secretHash, "hex"));
    return true;
  }

  /** A new secret for a run whose process is relaunched under a living bot
   *  (docs/reference/specs/harness-pi.md item 8: a re-attach adopts, a relaunch
   *  rotates): the same entry, so the turns spent, the expiry and the span are
   *  exactly what they were — `mint` would reset them and hand each relaunch a
   *  fresh budget. Ordered for a bot death: the new hash joins the entry and is
   *  handed to `record` — the caller's write of the run's row — BEFORE every
   *  earlier hash is dropped, so a generation that dies between the two steps
   *  leaves a row naming the secret this relaunch was minted, never the
   *  orphan's; a `record` that throws propagates with both still verifying
   *  and the old secrets never dropped. `record` must ISSUE the row's write
   *  synchronously — the run's `saveFacts`, which queues on the ledger's
   *  write-through — and nothing may write the facts between it and this
   *  method's return: what the store orders is the queue position of that
   *  write, which the write-through flushes in order, so a facts write queued
   *  after `record` returned would carry the old hash ahead of the new one.
   *  Refuses by name the runs `issue` mints nothing for, and hands `record`
   *  nothing then. */
  rotate(runId: string, record: (secretHash: string) => void): RotateVerdict {
    const entry = this.entries.get(runId);
    if (!entry) return { ok: false, reason: "unknown_run" };
    if (entry.revoked) return { ok: false, reason: "revoked" };
    if (this.opts.clock() >= entry.grant.expiresAt) return { ok: false, reason: "expired" };
    const secret = randomBytes(SECRET_BYTES);
    const hash = hashOf(secret);
    entry.hashes.push(hash);
    record(hash.toString("hex"));
    entry.hashes = [hash];
    return { ok: true, token: token(runId, secret), expiresAt: entry.grant.expiresAt };
  }

  /** WHO a presented token is, by reason: malformed, an unknown run, a wrong
   *  secret for a known run, a run that ended, a bearer past its expiry — or
   *  the grant with the turns used so far. Constant-time over the run's secrets. */
  verify(presented: string): BearerVerdict {
    const parsed = parse(presented);
    if (!parsed) return { ok: false, reason: "malformed" };
    const entry = this.entries.get(parsed.runId);
    if (!entry) return { ok: false, reason: "unknown_run", runId: parsed.runId };
    const presentedHash = hashOf(parsed.secret);
    let matched = false;
    for (const hash of entry.hashes) if (constantTimeEqual(hash, presentedHash)) matched = true;
    if (!matched) return { ok: false, reason: "unknown_bearer", runId: parsed.runId };
    if (entry.revoked) return { ok: false, reason: "revoked", runId: parsed.runId };
    if (this.opts.clock() >= entry.grant.expiresAt) return { ok: false, reason: "expired", runId: parsed.runId };
    return { ok: true, grant: entry.grant, turns: entry.turns };
  }

  /** One more turn for the run, or the refusal: `ended` for a run revoked since
   *  its bearer verified (or never minted here), `budget` past `maxTurns` with
   *  the counts. Counted BEFORE the call is forwarded, so concurrent calls
   *  cannot overrun. */
  consumeTurn(runId: string): TurnVerdict {
    const entry = this.entries.get(runId);
    if (!entry || entry.revoked) return { ok: false, reason: "ended" };
    if (entry.turns >= entry.grant.maxTurns) {
      return { ok: false, reason: "budget", turns: entry.turns, maxTurns: entry.grant.maxTurns };
    }
    entry.turns++;
    return { ok: true, turn: entry.turns };
  }

  /** Hang the run's proxied turns under another span from here on: the
   *  harness's own `run.agent` in place of the request root the mint named
   *  (docs/reference/specs/harness-pi.md item 5), so a proxied `model.turn`
   *  lands where the native loop's would. False for a run this store never
   *  minted or one that ended. */
  reparent(runId: string, span: Span): boolean {
    const entry = this.entries.get(runId);
    if (!entry || entry.revoked) return false;
    entry.grant = { ...entry.grant, span };
    return true;
  }

  /** The run ended: every bearer of it stops buying calls. The entry stays
   *  until its expiry so a late call is answered `revoked`, not `unknown_run`.
   *  True when a live entry was revoked; false for an unknown or already-ended run. */
  revoke(runId: string): boolean {
    const entry = this.entries.get(runId);
    if (!entry || entry.revoked) return false;
    entry.revoked = true;
    return true;
  }

  /** The run's grant and counters, for an operator surface — never its secrets. */
  /** The span a run's proxied turns hang under (`reparent`), for a meter that
   *  holds the run and not a token — the tests' scripted pi, which stands in
   *  for the proxy's meter as well as for pi. Nothing for an unknown or ended run. */
  spanOf(runId: string): Span | undefined {
    const entry = this.entries.get(runId);
    return entry && !entry.revoked ? entry.grant.span : undefined;
  }

  grantOf(runId: string): RunBearerFacts | undefined {
    const entry = this.entries.get(runId);
    if (!entry) return undefined;
    const { span: _span, publish: _publish, ...facts } = entry.grant;
    return { ...facts, turns: entry.turns, bearers: entry.hashes.length, revoked: entry.revoked };
  }

  /** Drop every entry past its expiry (revoked or not). Returns how many went. */
  sweep(): number {
    const now = this.opts.clock();
    let swept = 0;
    for (const [runId, entry] of this.entries) {
      if (now >= entry.grant.expiresAt) {
        this.entries.delete(runId);
        swept++;
      }
    }
    return swept;
  }

  size(): number {
    return this.entries.size;
  }
}

function token(runId: string, secret: Buffer): string {
  return `${BEARER_PREFIX}${runId}.${secret.toString("base64url")}`;
}

/** The SHA-256 of a token's secret, hex — what a run's row may carry to name
 *  the bearer its pi holds (docs/reference/specs/harness-pi.md item 8) without
 *  carrying a credential: the hash verifies nothing on its own. Nothing for a
 *  token of another shape. */
export function bearerHashOf(presented: string): string | undefined {
  const parsed = parse(presented);
  return parsed ? hashOf(parsed.secret).toString("hex") : undefined;
}

function hashOf(secret: Buffer): Buffer {
  return createHash("sha256").update(secret).digest();
}

/** `sbr_<runId>.<secret>` → its parts, or nothing for any other shape. A run id
 *  carries no `.` (`RUN_ID_PATTERN`), so the first dot splits exactly. */
function parse(presented: string): { runId: string; secret: Buffer } | undefined {
  if (!presented.startsWith(BEARER_PREFIX)) return undefined;
  const rest = presented.slice(BEARER_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return undefined;
  const runId = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId) || !/^[A-Za-z0-9_-]+$/.test(secret)) return undefined;
  return { runId, secret: Buffer.from(secret, "base64url") };
}

/** Equal bytes in time that depends on the lengths alone. */
function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
