import { redactSecrets } from "../redact.js";
import { identityKey } from "../identity/engine.js";
import type { BindingResolution, ExternalIdentity } from "../identity/contract.js";
import {
  commandSchema,
  envelopeSchema,
  receiptSchema,
  stateSchema,
  streamEntrySchema,
  type OrganizationActor,
  type OrganizationCommand,
  type OrganizationEnvelope,
  type OrganizationReceipt,
  type OrganizationResult,
  type OrganizationState,
  type OrganizationStreamEntry,
} from "./contract.js";

export interface OrganizationRows {
  get(kind: string, org: string, key: string): unknown;
  put(
    kind: string,
    org: string,
    key: string,
    value: unknown,
    partition?: string,
    ordinal?: number,
    expiry?: number,
  ): void;
  remove(kind: string, org: string, key: string): void;
  list(
    kind: string,
    org: string,
    options?: { partition?: string; after?: number; limit?: number; expiresBefore?: number; receiptId?: string },
  ): unknown[];
  binding(identity: ExternalIdentity): BindingResolution;
  identities(personId: string): ExternalIdentity[];
}
function state(rows: OrganizationRows, organization: string): OrganizationState {
  const raw = rows.get("state", organization, "state");
  if (raw !== undefined) {
    const parsed = stateSchema.parse(raw);
    if (parsed.organization !== organization || parsed.orchestrator !== `organization:${organization}`)
      throw new Error("organization state unavailable");
    return parsed;
  }
  return {
    version: 1,
    organization,
    orchestrator: `organization:${organization}`,
    revision: 0,
    wakeSequence: 0,
    reconciledSequence: 0,
    streamSequence: 0,
    laneCursor: null,
    lease: null,
  };
}
function owns(s: OrganizationState, owner: string, generation: number, now: number): boolean {
  return !!s.lease && s.lease.owner === owner && s.lease.generation === generation && s.lease.expiresAt > now;
}
function validActor(rows: OrganizationRows, organization: string, actor: OrganizationActor): boolean {
  if (rows.get("revoked-source", organization, identityKey(actor.identity)) === true) return false;
  if (actor.kind === "service" && actor.onBehalfOf === null)
    return actor.stream === null && actor.bindingRevision === 0;
  const current = rows.binding(actor.onBehalfOf ?? actor.identity);
  if (current.status === "bound")
    return actor.stream === current.binding.personId && actor.bindingRevision === current.binding.revision;
  return (
    current.status === "unknown" &&
    actor.kind === "human" &&
    actor.stream === actor.principal &&
    actor.bindingRevision === 0
  );
}
function releaseReservation(rows: OrganizationRows, org: string, envelope: OrganizationEnvelope, receiptId: string) {
  if (!envelope.target) return;
  const reservation = rows.get("reservation", org, envelope.target.key) as
    { receiptId: string; revision: number } | undefined;
  if (reservation?.receiptId === receiptId) rows.remove("reservation", org, envelope.target.key);
}
function rejectPending(
  rows: OrganizationRows,
  org: string,
  envelope: OrganizationEnvelope,
  now: number,
  reason: string,
) {
  const scope = JSON.stringify([envelope.source, identityKey(envelope.actor.identity), envelope.key]);
  const receipt = receiptSchema.parse(rows.get("receipt", org, scope));
  if (receipt.status !== "pending") return;
  receipt.status = "rejected";
  receipt.reason = reason;
  receipt.settledAt = now;
  rows.put("receipt", org, scope, receiptSchema.parse(receipt), receipt.id, 0, receipt.expiresAt);
  rows.remove("pending", org, receipt.id);
  releaseReservation(rows, org, envelope, receipt.id);
}
function eligiblePending(
  rows: OrganizationRows,
  org: string,
  now: number,
  changed: () => void = () => {},
): OrganizationEnvelope[] {
  return rows
    .list("pending", org)
    .map((value) => envelopeSchema.parse(value))
    .filter((envelope) => {
      if (envelope.contentExpiresAt === undefined || envelope.contentExpiresAt <= now) {
        rejectPending(rows, org, envelope, now, "Message expired.");
        changed();
        return false;
      }
      if (!validActor(rows, org, envelope.actor)) {
        rejectPending(rows, org, envelope, now, "Access changed.");
        changed();
        return false;
      }
      return true;
    });
}
function append(
  rows: OrganizationRows,
  s: OrganizationState,
  envelope: OrganizationEnvelope,
  receipt: OrganizationReceipt,
  role: OrganizationStreamEntry["role"],
  content: string,
  now: number,
  ttl: number,
) {
  if (envelope.destination.kind !== "broad" || envelope.actor.stream === null) return;
  s.streamSequence++;
  const entry: OrganizationStreamEntry = {
    version: 1,
    sequence: s.streamSequence,
    stream: envelope.actor.stream,
    receiptId: receipt.id,
    source: envelope.source,
    sourceEvent: envelope.sourceEvent,
    identity: envelope.actor.identity,
    onBehalfOf: envelope.actor.onBehalfOf,
    role,
    content: redactSecrets(content),
    createdAt: now,
    expiresAt: now + ttl,
  };
  rows.put(
    "stream",
    s.organization,
    String(entry.sequence),
    streamEntrySchema.parse(entry),
    entry.stream,
    entry.sequence,
    entry.expiresAt,
  );
}
/** One synchronous transaction decides receipts and outbox rows before any effect. */
export function executeOrganization(
  rows: OrganizationRows,
  input: OrganizationCommand,
  now: number,
): OrganizationResult {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success || !Number.isSafeInteger(now) || now < 0) return { status: "invalid" };
  const command = parsed.data;
  // Redaction can expand valid raw text. Refuse before any state changes;
  // truncating an instruction would admit a different act.
  if (command.action === "admit") {
    const sanitized = envelopeSchema.safeParse({
      ...command.envelope,
      content: redactSecrets(command.envelope.content),
    });
    if (!sanitized.success) return { status: "invalid" };
    command.envelope = sanitized.data;
  }
  if (command.action === "settle") {
    const sanitized = commandSchema.safeParse({
      ...command,
      reason: command.reason === null ? null : redactSecrets(command.reason),
      reply: command.reply === null ? null : redactSecrets(command.reply),
    });
    if (!sanitized.success || sanitized.data.action !== "settle") return { status: "invalid" };
    command.reason = sanitized.data.reason;
    command.reply = sanitized.data.reply;
  }
  const org = command.action === "admit" ? command.envelope.organization : command.organization;
  if (command.action !== "expire") executeOrganization(rows, { action: "expire", organization: org }, now);
  const s = state(rows, org);
  const save = () => rows.put("state", org, "state", stateSchema.parse(s));
  const stateResult = (): OrganizationResult => {
    save();
    return { status: "state", state: s };
  };
  if (command.action === "access") {
    if (command.allowed) rows.remove("revoked-source", org, identityKey(command.identity));
    else rows.put("revoked-source", org, identityKey(command.identity), true);
    eligiblePending(rows, org, now, () => s.revision++);
    s.revision++;
    save();
    return { status: "ok", removed: 0 };
  }
  if (command.action === "issue") {
    if (!validActor(rows, org, command.actor)) return { status: "fenced" };
    const key = crypto.randomUUID();
    const expiresAt = now + command.ttlMs;
    if (!Number.isSafeInteger(expiresAt)) return { status: "invalid" };
    rows.put(
      "issued",
      org,
      JSON.stringify([command.source, identityKey(command.actor.identity), key]),
      { actor: command.actor, expiresAt, key, source: command.source },
      "",
      0,
      expiresAt,
    );
    return { status: "key", key, expiresAt };
  }
  if (command.action === "identities") return { status: "identities", identities: rows.identities(command.personId) };
  if (command.action === "get") return { status: "state", state: s };
  if (command.action === "wake") {
    s.wakeSequence++;
    s.revision++;
    return stateResult();
  }
  if (command.action === "claim") {
    if (s.lease && s.lease.expiresAt > now) return { status: "busy" };
    s.lease = {
      owner: command.owner,
      generation: (s.lease?.generation ?? 0) + 1,
      expiresAt: now + command.leaseMs,
      through: s.wakeSequence,
      admissionRevision: s.revision,
    };
    s.revision++;
    return stateResult();
  }
  if (command.action === "complete") {
    if (!owns(s, command.owner, command.generation, now)) return { status: "fenced" };
    if (command.through !== s.lease!.through) return { status: "stale" };
    if (
      eligiblePending(rows, org, now, () => s.revision++).some((envelope) => {
        const receipt = receiptSchema.parse(
          rows.get(
            "receipt",
            org,
            JSON.stringify([envelope.source, identityKey(envelope.actor.identity), envelope.key]),
          ),
        );
        return receipt.revision <= s.lease!.admissionRevision;
      })
    ) {
      save();
      return { status: "busy" };
    }
    s.reconciledSequence = Math.max(s.reconciledSequence, command.through);
    // Retain the generation after release so an old process can never reuse it.
    s.lease!.expiresAt = now;
    s.revision++;
    return stateResult();
  }
  if (command.action === "observe") {
    const current = rows.get("target", org, command.target);
    if (typeof current === "number" && current > command.revision) return { status: "stale" };
    if (current !== undefined && typeof current !== "number") throw new Error("organization target unavailable");
    rows.put("target", org, command.target, command.revision);
    if (current !== command.revision) {
      s.revision++;
      save();
    }
    const reservation = rows.get("reservation", org, command.target) as { revision: number } | undefined;
    if (reservation && reservation.revision < command.revision) rows.remove("reservation", org, command.target);
    return { status: "ok", removed: 0 };
  }
  if (command.action === "admit") {
    const e = command.envelope;
    const scope = JSON.stringify([e.source, identityKey(e.actor.identity), e.key]);
    const previous = rows.get("receipt", org, scope);
    if (previous !== undefined) {
      const receipt = receiptSchema.parse(previous);
      return receipt.digest === e.digest ? { status: "receipt", receipt, duplicate: true } : { status: "conflict" };
    }
    if (!validActor(rows, org, e.actor)) return { status: "fenced" };
    if (e.source === "browser") {
      const issued = rows.get("issued", org, scope) as
        { actor: OrganizationEnvelope["actor"]; expiresAt: number } | undefined;
      if (!issued || issued.expiresAt <= now || JSON.stringify(issued.actor) !== JSON.stringify(e.actor))
        return { status: "invalid" };
    }
    const pending = eligiblePending(rows, org, now, () => s.revision++);
    const reconciliation = e.workload === "reconciliation";
    const ordinary = pending.filter((p) => p.workload !== "reconciliation");
    const lane = pending.filter(
      (p) =>
        p.workload === e.workload &&
        p.source === e.source &&
        identityKey(p.actor.identity) === identityKey(e.actor.identity),
    );
    const overloaded =
      lane.length >= command.limits.pendingPerActor ||
      (!reconciliation &&
        (ordinary.length >= command.limits.pendingPerOrganization - command.limits.reservedReconciliation ||
          ordinary.filter((p) => p.source === e.source).length >= command.limits.pendingPerSource)) ||
      (reconciliation &&
        pending.filter((p) => p.workload === "reconciliation").length >= command.limits.reservedReconciliation);
    const current = e.target ? rows.get("target", org, e.target.key) : undefined;
    if (current !== undefined && typeof current !== "number") throw new Error("organization target unavailable");
    const reservation = e.target ? rows.get("reservation", org, e.target.key) : undefined;
    const stale = !!e.target && (current === undefined || current !== e.target.revision || reservation !== undefined);
    s.revision++;
    const id = `${s.orchestrator}:${s.revision}`;
    const status = stale ? "stale" : overloaded ? "throttled" : "pending";
    const receipt: OrganizationReceipt = {
      version: 1,
      id,
      organization: org,
      source: e.source,
      sourceEvent: e.sourceEvent,
      actor: e.actor,
      key: e.key,
      digest: e.digest,
      status,
      reason: stale
        ? "The work changed. Reload its current state."
        : overloaded
          ? "Too many pending requests in this lane."
          : null,
      revision: s.revision,
      target: e.target?.key ?? null,
      currentRevision: typeof current === "number" ? current : null,
      effectKey: status === "pending" ? id : null,
      createdAt: now,
      settledAt: status === "pending" ? null : now,
      expiresAt: now + command.limits.receiptTtlMs,
    };
    rows.put("receipt", org, scope, receiptSchema.parse(receipt), id, 0, receipt.expiresAt);
    rows.put("receipt-key", org, id, scope);
    if (status === "pending") {
      if (e.target) rows.put("reservation", org, e.target.key, { revision: e.target.revision, receiptId: id });
      rows.put(
        "pending",
        org,
        id,
        envelopeSchema.parse({ ...e, contentExpiresAt: now + command.limits.contentTtlMs }),
        e.actor.principal,
        s.revision,
        now + command.limits.contentTtlMs,
      );
      s.wakeSequence++;
      append(rows, s, e, receipt, "user", e.content, now, command.limits.contentTtlMs);
    }
    save();
    return { status: "receipt", receipt, duplicate: false };
  }
  if (command.action === "pending") {
    if (!owns(s, command.owner, command.generation, now)) return { status: "fenced" };
    // Round-robin principals; reconciliation is reserved and selected first.
    const pending = eligiblePending(rows, org, now, () => s.revision++);
    const lanes = new Map<string, OrganizationEnvelope[]>();
    for (const envelope of pending) {
      if (!validActor(rows, org, envelope.actor)) continue;
      const receipt = receiptSchema.parse(
        rows.get("receipt", org, JSON.stringify([envelope.source, identityKey(envelope.actor.identity), envelope.key])),
      );
      if (receipt.revision > s.lease!.admissionRevision) continue;
      const key =
        envelope.workload === "reconciliation" ? "" : JSON.stringify([envelope.source, envelope.actor.principal]);
      lanes.set(key, [...(lanes.get(key) ?? []), envelope]);
    }
    const selected: OrganizationEnvelope[] = [];
    const sorted = [...lanes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const split = s.laneCursor === null ? 0 : sorted.findIndex(([key]) => key > s.laneCursor!);
    const start = split < 0 ? 0 : split;
    const ordered = [...sorted.slice(start), ...sorted.slice(0, start)];
    while (selected.length < command.limit && ordered.some(([, lane]) => lane.length))
      for (const [laneKey, lane] of ordered) {
        const e = lane.shift();
        if (e) {
          selected.push(e);
          s.laneCursor = laneKey;
        }
        if (selected.length === command.limit) break;
      }
    const receipts = selected.map((e) =>
      receiptSchema.parse(rows.get("receipt", org, JSON.stringify([e.source, identityKey(e.actor.identity), e.key]))),
    );
    save();
    return { status: "pending", envelopes: selected, receipts };
  }
  if (command.action === "effect") {
    if (!owns(s, command.owner, command.generation, now)) return { status: "fenced" };
    const scope = JSON.stringify([command.source, identityKey(command.actor.identity), command.key]);
    const raw = rows.get("receipt", org, scope);
    if (raw === undefined) return { status: "not_found" };
    const receipt = receiptSchema.parse(raw);
    if (receipt.status !== "pending" || receipt.revision > s.lease!.admissionRevision) return { status: "stale" };
    const envelope = envelopeSchema.parse(rows.get("pending", org, receipt.id));
    if (JSON.stringify(command.actor) !== JSON.stringify(receipt.actor) || !validActor(rows, org, command.actor))
      return { status: "fenced" };
    if (
      envelope.contentExpiresAt === undefined ||
      envelope.contentExpiresAt <= now ||
      (envelope.target && rows.get("target", org, envelope.target.key) !== envelope.target.revision)
    ) {
      rejectPending(rows, org, envelope, now, "The work or retention changed.");
      s.revision++;
      save();
      return { status: "stale" };
    }
    return { status: "receipt", receipt, duplicate: false };
  }
  if (command.action === "settle") {
    if (!owns(s, command.owner, command.generation, now)) return { status: "fenced" };
    const scope = rows.get("receipt-key", org, command.receiptId);
    if (typeof scope !== "string") return { status: "not_found" };
    const receipt = receiptSchema.parse(rows.get("receipt", org, scope));
    if (receipt.status !== "pending") return { status: "receipt", receipt, duplicate: true };
    if (receipt.revision > s.lease!.admissionRevision) return { status: "stale" };
    const envelope = envelopeSchema.parse(rows.get("pending", org, receipt.id));
    if (
      envelope.contentExpiresAt === undefined ||
      envelope.contentExpiresAt <= now ||
      !validActor(rows, org, envelope.actor)
    ) {
      rejectPending(rows, org, envelope, now, "Access or retention changed.");
      s.revision++;
      save();
      return { status: "receipt", receipt: receiptSchema.parse(rows.get("receipt", org, scope)), duplicate: false };
    }
    s.revision++;
    receipt.status = command.status;
    receipt.reason = command.reason;
    receipt.settledAt = now;
    rows.put("receipt", org, scope, receiptSchema.parse(receipt), receipt.id, 0, receipt.expiresAt);
    rows.remove("pending", org, receipt.id);
    if (command.status === "rejected") releaseReservation(rows, org, envelope, receipt.id);
    if (command.reply && validActor(rows, org, envelope.actor))
      append(rows, s, envelope, receipt, "assistant", command.reply, now, command.contentTtlMs);
    save();
    return { status: "receipt", receipt, duplicate: false };
  }
  if (command.action === "stream") {
    if (command.actor.stream !== command.stream || !validActor(rows, org, command.actor)) return { status: "fenced" };
    const identities = new Set(command.identities.map(identityKey));
    const candidates = rows
      .list("stream", org, { partition: command.stream, after: command.after, limit: command.limit + 1 })
      .map((v) => streamEntrySchema.parse(v));
    const scanned = candidates.slice(0, command.limit);
    const eligible = scanned.filter((entry) => {
      if (rows.get("revoked-source", org, identityKey(entry.identity)) === true) return false;
      if (entry.expiresAt <= now || !identities.has(identityKey(entry.onBehalfOf ?? entry.identity))) return false;
      const binding = rows.binding(entry.onBehalfOf ?? entry.identity);
      return binding.status === "bound" ? binding.binding.personId === command.stream : binding.status === "unknown";
    });
    const entries = eligible;
    return {
      status: "stream",
      revision: s.revision,
      entries,
      cursor: scanned.at(-1)?.sequence ?? s.streamSequence,
      hasMore: candidates.length > scanned.length,
    };
  }
  if (command.action === "delete") {
    if (command.actor.stream !== command.stream || !validActor(rows, org, command.actor)) return { status: "fenced" };
    let removed = 0;
    for (const entry of rows
      .list("stream", org, { partition: command.stream, receiptId: command.receiptId })
      .map((v) => streamEntrySchema.parse(v)))
      if (entry.receiptId === command.receiptId) {
        rows.remove("stream", org, String(entry.sequence));
        removed++;
      }
    // Content deletion also makes queued work ineligible for future model context.
    const raw = rows.get("pending", org, command.receiptId);
    if (raw !== undefined) {
      const e = envelopeSchema.parse(raw);
      if (e.actor.stream === command.stream) {
        rows.remove("pending", org, command.receiptId);
        releaseReservation(rows, org, e, command.receiptId);
        const scope = rows.get("receipt-key", org, command.receiptId);
        if (typeof scope === "string") {
          const receipt = receiptSchema.parse(rows.get("receipt", org, scope));
          receipt.status = "rejected";
          receipt.reason = "Message deleted.";
          receipt.settledAt = now;
          rows.put("receipt", org, scope, receiptSchema.parse(receipt), receipt.id, 0, receipt.expiresAt);
        }
      }
    }
    if (removed > 0 || raw !== undefined) {
      s.revision++;
      save();
    }
    return { status: "ok", removed };
  }
  let removed = 0;
  for (const entry of rows
    .list("stream", org, { expiresBefore: now, limit: 1000 })
    .map((v) => streamEntrySchema.parse(v))) {
    rows.remove("stream", org, String(entry.sequence));
    removed++;
  }
  for (const issued of rows.list("issued", org, { expiresBefore: now, limit: 1000 }) as {
    actor: OrganizationEnvelope["actor"];
    expiresAt: number;
    key?: string;
    source?: string;
  }[]) {
    if (issued.key && issued.source)
      rows.remove("issued", org, JSON.stringify([issued.source, identityKey(issued.actor.identity), issued.key]));
  }
  for (const e of rows.list("pending", org, { expiresBefore: now, limit: 1000 }).map((v) => envelopeSchema.parse(v))) {
    rejectPending(rows, org, e, now, "Message expired.");
    removed++;
  }
  for (const receipt of rows
    .list("receipt", org, { expiresBefore: now, limit: 1000 })
    .map((v) => receiptSchema.parse(v))) {
    if (receipt.status === "pending") continue;
    const scope = rows.get("receipt-key", org, receipt.id);
    if (typeof scope !== "string") throw new Error("organization receipt unavailable");
    rows.remove("receipt", org, scope);
    rows.remove("receipt-key", org, receipt.id);
    removed++;
  }
  if (removed > 0) {
    s.revision++;
    save();
  }
  return { status: "ok", removed };
}
