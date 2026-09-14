// The run-scoped bearer (docs/reference/specs/model-proxy.md): the credential a
// run's harness presents to the bot's model proxy in place of a provider key.
// One is minted when a run's executor is provisioned, bound to the run's id,
// expiring at the run's wall-clock budget plus a margin, and revoked the moment
// the run ends — so a bearer authorizes exactly one run's model calls and no
// call after them. The store is in-process: a bot restart drops every bearer,
// which is the right answer (the run that held it is being resumed by a new
// generation, which mints its own). Nothing here logs, and a token never
// appears in a message: `verify` answers a reason, never the material.
//
// The token names its run — `sbr_<runId>.<secret>` — so the proxy can tell an
// unknown run (404) from a wrong secret for a known one (401) without a second
// lookup, and the secret is compared in constant time.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ProviderConfig } from "../../providers/types.js";
import type { RunEvent } from "../runEvents.js";
import type { Clock, Span } from "../trace/types.js";

/** How far past the run's budget a bearer stays valid: the write-up a budget
 *  exhaustion asks for, and the post-step, still have a credential. */
export const BEARER_MARGIN_MS = 5 * 60_000;
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
  /** Absolute: the run's budget plus `BEARER_MARGIN_MS`, from the mint. */
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

/** A run's grant as an operator may read it: the caps, the turns so far, whether it ended — never a secret. */
export type RunBearerFacts = Omit<RunBearerGrant, "span" | "publish"> & { turns: number; revoked: boolean };

interface Entry {
  grant: RunBearerGrant;
  /** Every secret minted for the run (the provision's, plus an operator's `issue`), as bytes. */
  secrets: Buffer[];
  turns: number;
  revoked: boolean;
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
    this.entries.set(grant.runId, { grant, secrets: [secret], turns: 0, revoked: false });
    return token(grant.runId, secret);
  }

  /** Another bearer for a run still live: the same entry, expiry and turn
   *  counter (an operator's probe spends the run's own turns). Nothing for a
   *  run this store never minted, one that ended, or one past its expiry. */
  issue(runId: string): { token: string; expiresAt: number } | undefined {
    const entry = this.entries.get(runId);
    if (!entry || entry.revoked || this.opts.clock() >= entry.grant.expiresAt) return undefined;
    const secret = randomBytes(SECRET_BYTES);
    entry.secrets.push(secret);
    return { token: token(runId, secret), expiresAt: entry.grant.expiresAt };
  }

  /** WHO a presented token is, by reason: malformed, an unknown run, a wrong
   *  secret for a known run, a run that ended, a bearer past its expiry — or
   *  the grant with the turns used so far. Constant-time over the run's secrets. */
  verify(presented: string): BearerVerdict {
    const parsed = parse(presented);
    if (!parsed) return { ok: false, reason: "malformed" };
    const entry = this.entries.get(parsed.runId);
    if (!entry) return { ok: false, reason: "unknown_run", runId: parsed.runId };
    let matched = false;
    for (const secret of entry.secrets) if (constantTimeEqual(secret, parsed.secret)) matched = true;
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
  grantOf(runId: string): RunBearerFacts | undefined {
    const entry = this.entries.get(runId);
    if (!entry) return undefined;
    const { span: _span, publish: _publish, ...facts } = entry.grant;
    return { ...facts, turns: entry.turns, revoked: entry.revoked };
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
