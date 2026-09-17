// The GitHub check-run intake (docs/reference/specs/http-ingress.md item 12;
// docs/reference/specs/agent-ship.md item 9): the poll-free half of the merge
// step's wait. GitHub posts a `check_run` webhook when a run completes; when
// every check at that head has settled, the intake sends the typed
// `checks-settled-<head>` event to each coordinator instance whose merge step
// waits at that head, and the driver's `waitForEvent` wakes at once instead of
// timing out its bounded fallback. Node-free — the signature check is Web
// Crypto — so the bot and a Worker verify the same way.
// One event kind is read here on purpose. The general door, every outside
// fact filed into the thread that owns the work, is docs/decisions/0047-an-outside-fact-finds-the-thread-that-owns-the-work.md;
// no second event-specific intake is added before it lands.
import { sendChecksSettled, type RunFinishedSend, type WorkflowSender } from "./contract.js";

/** The webhook header GitHub signs the raw body into: `sha256=<hex hmac>`. */
export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";
/** The event header naming the payload kind; only `check_run` is read. */
export const GITHUB_EVENT_HEADER = "x-github-event";

const encoder = new TextEncoder();

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** GitHub's HMAC-SHA256 signature over the raw body, compared without
 *  short-circuiting so a mismatch's position is not a timing oracle. */
export async function verifyWebhookSignature(secret: string, rawBody: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
  const expected = `sha256=${toHex(digest)}`;
  if (signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/** Who waits at which head: written by the bot's merge step when it answers
 *  `pending` (src/channels/adminCoordinator.ts), read by the intake to address
 *  the `checks-settled-<head>` sends. In-memory on purpose: a restart loses the
 *  waiters, and the driver's bounded merge wait (MERGE_WAIT_CHUNK_MS) re-asks
 *  the door on its own — the event is a fast path, never the correctness. */
export interface MergeWaitRegistry {
  /** Record that `instanceId`'s merge step waits at `headSha`. */
  note(headSha: string, instanceId: string, now: number): void;
  /** The instances still waiting at `headSha`, expired entries dropped. */
  waitingAt(headSha: string, now: number): string[];
}

/** One entry lives as long as the merge step's whole wait can (the merge wait's ask, `MERGE_WAIT_ASK_MINUTES` in the budgets module). */
export const MERGE_WAIT_TTL_MS = 60 * 60_000;

export function createMergeWaitRegistry(ttlMs: number = MERGE_WAIT_TTL_MS): MergeWaitRegistry {
  const byHead = new Map<string, Map<string, number>>();
  return {
    note(headSha, instanceId, now) {
      const entry = byHead.get(headSha) ?? new Map<string, number>();
      entry.set(instanceId, now);
      byHead.set(headSha, entry);
    },
    waitingAt(headSha, now) {
      const entry = byHead.get(headSha);
      if (!entry) return [];
      const alive: string[] = [];
      for (const [id, at] of entry) {
        if (now - at > ttlMs) entry.delete(id);
        else alive.push(id);
      }
      if (entry.size === 0) byHead.delete(headSha);
      return alive;
    },
  };
}

export interface CheckRunIntakeDeps {
  /** The webhook secret; absent, the intake is disabled — never open. */
  secret: string | undefined;
  /** Whether every check run at the head has settled (the merge door's own read of GitHub). */
  checksSettled(repo: string, headSha: string): Promise<boolean>;
  /** The coordinator instances whose merge step waits at this head. */
  instancesWaitingAt(headSha: string): Promise<string[]>;
  /** The Workflow engine the event goes to; absent, the send answers `no-binding`. */
  workflow: WorkflowSender | undefined;
  now(): number;
}

export interface CheckRunIntakeResult {
  status: number;
  body: Record<string, unknown>;
}

/** One webhook delivery: verify, read, and — when the completed run was the
 *  last at its head — send `checks-settled-<head>` to every waiting instance.
 *  Every outcome is an answer; the sends are best effort (the driver's bounded
 *  wait is the fallback). */
export async function handleCheckRunIntake(
  headers: { event?: string; signature?: string },
  rawBody: string,
  deps: CheckRunIntakeDeps,
): Promise<CheckRunIntakeResult> {
  if (deps.secret === undefined || deps.secret === "") return { status: 503, body: { error: "disabled" } };
  if (headers.signature === undefined || !(await verifyWebhookSignature(deps.secret, rawBody, headers.signature)))
    return { status: 401, body: { error: "unauthorized" } };
  if (headers.event !== "check_run") return { status: 200, body: { ok: true, ignored: "event" } };
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  if (typeof payload !== "object" || payload === null) return { status: 400, body: { error: "invalid_body" } };
  const p = payload as { action?: unknown; check_run?: { head_sha?: unknown }; repository?: { full_name?: unknown } };
  if (p.action !== "completed") return { status: 200, body: { ok: true, ignored: "action" } };
  const headSha = p.check_run?.head_sha;
  const repo = p.repository?.full_name;
  if (typeof headSha !== "string" || headSha === "" || typeof repo !== "string" || repo === "")
    return { status: 400, body: { error: "invalid_body" } };
  if (!(await deps.checksSettled(repo, headSha))) return { status: 200, body: { ok: true, settled: false } };
  const instances = await deps.instancesWaitingAt(headSha);
  const sends: RunFinishedSend[] = [];
  for (const instance of instances) sends.push(await sendChecksSettled(deps.workflow, instance, headSha, deps.now()));
  return {
    status: 200,
    body: { ok: true, settled: true, sent: sends.filter((s) => s.kind === "sent").length, of: instances.length },
  };
}
