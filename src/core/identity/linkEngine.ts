import type { BindingReceipt, ExternalIdentity, Person, PersonBinding } from "./contract.js";
import { identityKey, mintPerson, type StoredBinding } from "./engine.js";
import {
  linkAuditSchema,
  linkCommandSchema,
  linkIntentSchema,
  type ActiveLinkIntent,
  type LinkAudit,
  type LinkCommand,
  type LinkFailure,
  type LinkIntent,
  type LinkResult,
  type LinkView,
} from "./linkContract.js";

/** All calls, including reads and terminal audit writes, run under the store's
 * transaction fence. No network operation or asynchronous callback belongs here. */
export interface LinkTransaction {
  intent(id: string): unknown;
  audit(id: string): unknown;
  current(identity: ExternalIdentity): StoredBinding;
  putIntent(intent: LinkIntent, create?: boolean): void;
  putPerson(person: Person): void;
  putBinding(receipt: BindingReceipt): void;
  putAudit(audit: LinkAudit): void;
}
function view(i: LinkIntent): LinkView {
  return { id: i.id, state: i.state, revision: i.revision, expiresAt: i.expiresAt };
}
function owner(auth: LinkCommand["auth"]) {
  const { expiresAt: _expiresAt, ...bound } = auth;
  return bound;
}
function observation(identity: ExternalIdentity, beforeRevision: number, afterRevision = beforeRevision) {
  return { identity, beforeRevision, afterRevision };
}
function finish(tx: LinkTransaction, i: ActiveLinkIntent, receipt: LinkAudit): LinkResult {
  const successful = ["created", "linked", "already-linked"].includes(receipt.outcome);
  const state = successful
    ? "committed"
    : receipt.outcome === "cancelled" || receipt.outcome === "expired"
      ? receipt.outcome
      : "failed";
  // Staged proof and callback digests disappear at the terminal transition. The
  // browser digest authorizes bounded receipt reads only, never binding use.
  tx.putIntent({
    id: i.id,
    owner: i.owner,
    revision: i.revision + 1,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    resultExpiresAt: i.resultExpiresAt,
    state,
    outcome: receipt.outcome,
    // Keep independent terminal evidence: current bindings can later be revoked,
    // and a well-shaped audit alone cannot prove which relationship committed.
    receipt: structuredClone(receipt),
  });
  tx.putAudit(receipt);
  return successful ? { status: "committed", receipt } : { status: receipt.outcome as LinkFailure };
}
function audit(i: ActiveLinkIntent, now: number, outcome: LinkAudit["outcome"], consent: boolean): LinkAudit {
  return {
    id: i.id,
    actor: i.owner.identity,
    access: observation(i.owner.identity, i.accessRevision),
    slack: i.slack ? observation(i.slack.identity, i.slack.expectedRevision) : null,
    personId: null,
    consent,
    outcome,
    proofVersion: i.owner.proofVersion,
    at: now,
  };
}
function refuse(
  tx: LinkTransaction,
  i: ActiveLinkIntent,
  now: number,
  reason: LinkFailure,
  consent = false,
): LinkResult {
  return finish(tx, i, audit(i, now, reason, consent));
}
function commit(tx: LinkTransaction, i: ActiveLinkIntent, now: number): LinkResult {
  if (!i.slack) return { status: "not_ready" };
  const identities = [i.owner.identity, i.slack.identity];
  if (identityKey(identities[0]) === identityKey(identities[1])) return refuse(tx, i, now, "conflict", true);
  const current = identities.map((identity) => tx.current(identity));
  if (current.some((c) => c.status === "conflict")) return refuse(tx, i, now, "conflict", true);
  const bindings = current.map((c) => (c.status === "present" ? c.binding : undefined));
  const expected = [i.accessRevision, i.slack.expectedRevision];
  if (bindings.some((b, n) => (b?.revision ?? 0) !== expected[n])) return refuse(tx, i, now, "stale", true);
  if (bindings.some((b) => b?.state === "revoked")) return refuse(tx, i, now, "revoked", true);
  if (bindings[0] && bindings[1] && bindings[0].personId !== bindings[1].personId)
    return refuse(tx, i, now, "conflict", true);
  const existing = bindings[0] ?? bindings[1];
  const person = existing ? undefined : mintPerson(now);
  const personId = existing?.personId ?? person!.id;
  const receipt = audit(i, now, person ? "created" : bindings.every(Boolean) ? "already-linked" : "linked", true);
  receipt.personId = personId;
  receipt.access.afterRevision = bindings[0]?.revision ?? 1;
  receipt.slack!.afterRevision = bindings[1]?.revision ?? 1;
  if (person) tx.putPerson(person);
  identities.forEach((identity, index) => {
    if (bindings[index]) return;
    const binding: PersonBinding = {
      identity,
      personId,
      state: "active",
      revision: 1,
      proof: { method: "dual-authentication", version: i.owner.proofVersion },
      changedAt: now,
    };
    tx.putBinding({ action: "link", actor: i.owner.identity, binding });
  });
  return finish(tx, i, receipt);
}

/** Pure synchronous orchestration over a transactional adapter, shared by both
 * stores so failure precedence, consent, selection and replay cannot diverge. */
export function executeLink(tx: LinkTransaction, input: LinkCommand, now: number): LinkResult {
  const parsed = linkCommandSchema.safeParse(input);
  if (!parsed.success || !Number.isSafeInteger(now) || now < 0) return { status: "invalid" };
  const c = parsed.data;
  if (c.auth.expiresAt <= now) return { status: "invalid" };
  if (c.action === "begin") {
    const expiresAt = Math.min(c.expiresAt, c.auth.expiresAt);
    if (expiresAt <= now || c.resultExpiresAt < expiresAt) return { status: "invalid" };
    const intent: ActiveLinkIntent = {
      id: `link:${crypto.randomUUID()}`,
      owner: owner(c.auth),
      revision: 1,
      state: "pending",
      createdAt: now,
      expiresAt,
      resultExpiresAt: c.resultExpiresAt,
      accessRevision: c.accessRevision,
      slackPolicy: c.slackPolicy,
      stateHash: c.stateHash,
      nonceHash: c.nonceHash,
      slack: null,
    };
    // Validate minted ids as well as caller input before storing any row.
    tx.putIntent(linkIntentSchema.parse(intent), true);
    return { status: "ok", intent: view(intent) };
  }
  const raw = tx.intent(c.id);
  if (raw === undefined) return { status: "not_found" };
  const stored = linkIntentSchema.safeParse(raw);
  if (!stored.success || stored.data.id !== c.id) return { status: "conflict" };
  const i = stored.data;
  if (
    identityKey(i.owner.identity) !== identityKey(c.auth.identity) ||
    i.owner.audience !== c.auth.audience ||
    i.owner.browserHash !== c.auth.browserHash
  )
    return { status: "not_found" };
  if (i.owner.proofVersion !== c.auth.proofVersion) return { status: "stale" };
  if ("outcome" in i) {
    if (now >= i.resultExpiresAt) return { status: "expired" };
    const storedAudit = linkAuditSchema.safeParse(tx.audit(i.id));
    // Both schemas normalize object-key order before comparing the entire receipt.
    if (!storedAudit.success || JSON.stringify(storedAudit.data) !== JSON.stringify(i.receipt))
      return { status: "conflict" };
    if (i.state !== "committed") return { status: i.outcome as LinkFailure };
    // A duplicate callback is never permission to exchange again, even after
    // commit. Only a result read or consent retry may receive the old receipt.
    if (c.action !== "read" && c.action !== "commit") return { status: "already_claimed" };
    if (c.action === "commit") {
      if (c.expectedRevision !== i.revision - 1) return { status: "stale" };
      if (!c.consent) return { status: "consent_required" };
    }
    return { status: "committed", receipt: storedAudit.data };
  }
  if (now >= i.expiresAt) return refuse(tx, i, now, "expired");
  if (c.action === "read") return { status: "ok", intent: view(i) };
  if (c.expectedRevision !== i.revision) return { status: "stale" };
  if (c.action === "cancel") return refuse(tx, i, now, "cancelled");
  if (c.action === "interrupt")
    return i.state === "exchanging" ? refuse(tx, i, now, "failed") : { status: "not_ready" };
  if (c.action === "claim") {
    if (i.state !== "pending") return { status: "already_claimed" };
    if (c.stateHash !== i.stateHash) return { status: "invalid" };
    const next: ActiveLinkIntent = { ...i, revision: i.revision + 1, state: "exchanging" };
    tx.putIntent(next);
    return { status: "claimed", intent: view(next) };
  }
  if (c.action === "prove") {
    if (i.state !== "exchanging") return { status: "not_ready" };
    const p = c.proof;
    if (
      p.nonceHash !== i.nonceHash ||
      p.identity.tenant !== i.slackPolicy.tenant ||
      p.audience !== i.slackPolicy.audience ||
      p.callbackUri !== i.slackPolicy.callbackUri
    )
      return { status: "invalid" };
    if (p.expiresAt <= now) return refuse(tx, i, now, "expired");
    const next: ActiveLinkIntent = {
      ...i,
      revision: i.revision + 1,
      state: "awaiting-consent",
      expiresAt: Math.min(i.expiresAt, p.expiresAt, c.auth.expiresAt),
      slack: p,
    };
    tx.putIntent(next);
    return { status: "ok", intent: view(next) };
  }
  if (i.state !== "awaiting-consent") return { status: "not_ready" };
  if (!c.consent) return { status: "consent_required" };
  return commit(tx, i, now);
}
