import { sourceAuthority, sourcePolicySchema } from "./accessCatalogue.js";
import { ORG_RECONCILE_BATCH_MAX } from "../budgets.js";
import { redactSecrets } from "../redact.js";
import { identityKey } from "../identity/engine.js";
import type { BindingResolution, ExternalIdentity } from "../identity/contract.js";
import {
  commandSchema,
  envelopeSchema,
  receiptSchema,
  stateSchema,
  streamEntrySchema,
  replyAddressSchema,
  replyKeySchema,
  bindingCutoffSchema,
  sourceProvenanceSchema,
  sourceDeletionSchema,
  sourceDeletionKey,
  sourceDeletionAddressOf,
  type SourceDeletionAddress,
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
    options?: {
      sourceIdentity?: ExternalIdentity;
      partition?: string;
      partitions?: string[];
      after?: number;
      before?: number;
      descending?: boolean;
      limit?: number;
      expiresBefore?: number;
      receiptId?: string;
      afterKey?: string;
      keyOrder?: boolean;
      sourceMessage?: SourceDeletionAddress;
    },
  ): unknown[];
  binding(identity: ExternalIdentity): BindingResolution;
  ownPartition(identity: ExternalIdentity, revision: number): string | undefined;
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
    accessRevision: 0,
    sourcePolicyRevision: 0,
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
  // Unlinked delegation keeps the service's source partition, never a person join.
  if (current.status === "revoked")
    return actor.stream === actor.principal && actor.bindingRevision === current.revision;
  return current.status === "unknown" && actor.stream === actor.principal && actor.bindingRevision === 0;
}
function ownPartition(rows: OrganizationRows, actor: OrganizationActor): string | undefined {
  return actor.stream === actor.principal && actor.bindingRevision > 0
    ? rows.ownPartition(actor.onBehalfOf ?? actor.identity, actor.bindingRevision)
    : undefined;
}
function releaseReservation(rows: OrganizationRows, org: string, envelope: OrganizationEnvelope, receiptId: string) {
  if (!envelope.target) return;
  const reservation = rows.get("reservation", org, envelope.target.key) as
    { receiptId: string; revision: number } | undefined;
  if (reservation?.receiptId === receiptId) rows.remove("reservation", org, envelope.target.key);
}
function deletedSource(
  rows: OrganizationRows,
  org: string,
  value: Parameters<typeof sourceDeletionAddressOf>[0],
  now: number,
): boolean {
  const address = sourceDeletionAddressOf(value);
  if (!address) return false;
  const raw = rows.get("source-delete", org, sourceDeletionKey(address));
  if (raw === undefined) return false;
  const deleted = sourceDeletionSchema.parse(raw);
  return !deleted.complete || deleted.expiresAt > now;
}
/** Erase copied content without replacing a canonical or already accepted owner. */
function clearReceiptContent(
  rows: OrganizationRows,
  org: string,
  id: string,
  now: number,
  limit: number,
  address: SourceDeletionAddress,
): { removed: number; complete: boolean } {
  const scope = rows.get("receipt-key", org, id);
  if (typeof scope === "string") {
    const receipt = receiptSchema.parse(rows.get("receipt", org, scope));
    if (receipt.effectKey)
      rows.put("owner-clear", org, id, {
        receiptId: id,
        effectKey: receipt.effectKey,
        expiresAt: receipt.expiresAt,
        address,
      });
  }
  rows.remove("reply-address", org, id);
  const entries = rows
    .list("stream", org, { receiptId: id, limit: limit + 1 })
    .map((value) => streamEntrySchema.parse(value));
  const selected = entries.slice(0, limit);
  for (const entry of selected) rows.remove("stream", org, String(entry.sequence));
  const raw = rows.get("pending", org, id);
  if (raw !== undefined) {
    const pending = envelopeSchema.parse(raw);
    rows.remove("pending", org, id);
    releaseReservation(rows, org, pending, id);
    if (typeof scope === "string") {
      const receipt = receiptSchema.parse(rows.get("receipt", org, scope));
      receipt.status = "rejected";
      receipt.reason = "Message deleted.";
      receipt.settledAt = now;
      rows.put("receipt", org, scope, receiptSchema.parse(receipt), id, 0, receipt.expiresAt);
    }
  }
  return { removed: selected.length, complete: entries.length <= limit };
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
      if (deletedSource(rows, org, envelope, now)) {
        rejectPending(rows, org, envelope, now, "Source message deleted.");
        changed();
        return false;
      }
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
function catalogueSource(
  rows: OrganizationRows,
  s: OrganizationState,
  envelope: OrganizationEnvelope,
  expiresAt: number,
) {
  if (envelope.actor.stream === null) return;
  // An older database without this index cannot certify a complete catalogue.
  if (s.streamSequence === 0 && rows.get("source-policy-index", s.organization, "version") === undefined)
    rows.put("source-policy-index", s.organization, "version", 1);
  const authority = sourceAuthority(envelope.source, envelope.actor, envelope.sourceReference);
  const key = JSON.stringify([envelope.actor.stream, authority]);
  const prior = rows.get("source-policy", s.organization, key);
  const expiry = Math.max(expiresAt, prior === undefined ? 0 : sourcePolicySchema.parse(prior).expiresAt);
  const previous = prior === undefined ? undefined : sourcePolicySchema.parse(prior);
  if (
    !previous ||
    previous.sourceReference?.privateSource !== envelope.sourceReference?.privateSource ||
    previous.sourceReference?.questionOwnership?.questionDigest !==
      envelope.sourceReference?.questionOwnership?.questionDigest
  )
    s.sourcePolicyRevision++;

  rows.put(
    "source-policy",
    s.organization,
    key,
    sourcePolicySchema.parse({
      version: 1,
      authority,
      ...(prior === undefined ? {} : { observedFingerprint: sourcePolicySchema.parse(prior).observedFingerprint }),
      source: envelope.source,
      actor: envelope.actor,
      ...(envelope.sourceReference ? { sourceReference: envelope.sourceReference } : {}),
      expiresAt: expiry,
    }),
    envelope.actor.stream,
    0,
    expiry,
  );
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
  const provenance = sourceProvenanceSchema.parse(rows.get("source-provenance", s.organization, receipt.id));
  catalogueSource(
    rows,
    s,
    { ...envelope, source: provenance.source, actor: provenance.actor, sourceReference: provenance.sourceReference },
    Math.max(receipt.expiresAt, now + ttl),
  );
  s.streamSequence++;
  if (role === "user") provenance.admissionSequence ??= s.streamSequence;
  const entry: OrganizationStreamEntry = {
    version: 1,
    sequence: s.streamSequence,
    ...(provenance.admissionSequence === undefined ? {} : { admissionSequence: provenance.admissionSequence }),
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
  // A shorter reply cannot expire proof that an older retained entry still needs.
  provenance.retentionDeadline = Math.max(
    provenance.retentionDeadline ??
      Math.max(
        0,
        ...rows
          .list("stream", s.organization, { receiptId: receipt.id })
          .map((value) => streamEntrySchema.parse(value).expiresAt),
      ),
    receipt.expiresAt,
    entry.expiresAt,
  );
  rows.put(
    "source-provenance",
    s.organization,
    receipt.id,
    provenance,
    undefined,
    undefined,
    provenance.retentionDeadline,
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
  if (command.action === "owner-refused") {
    const sanitized = commandSchema.safeParse({ ...command, reason: redactSecrets(command.reason) });
    if (!sanitized.success || sanitized.data.action !== "owner-refused") return { status: "invalid" };
    command.reason = sanitized.data.reason;
  }
  if (command.action === "reply") {
    const sanitized = commandSchema.safeParse({ ...command, content: redactSecrets(command.content) });
    if (!sanitized.success || sanitized.data.action !== "reply") return { status: "invalid" };
    command.content = sanitized.data.content;
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
    const changed = (rows.get("revoked-source", org, identityKey(command.identity)) !== true) !== command.allowed;
    if (command.allowed) rows.remove("revoked-source", org, identityKey(command.identity));
    else rows.put("revoked-source", org, identityKey(command.identity), true);
    eligiblePending(rows, org, now, () => s.revision++);
    s.revision++;
    if (changed) s.accessRevision++;
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
  if (command.action === "source-deletes")
    return {
      status: "source-deletes",
      addresses: rows
        .list("source-delete", org, { partition: "pending", limit: command.limit })
        .map((value) => sourceDeletionSchema.parse(value))
        .filter((row) => !row.complete)
        .map((row) => row.address),
    };
  if (command.action === "delete-source") {
    const key = sourceDeletionKey(command.address);
    const raw = rows.get("source-delete", org, key);
    const prior = raw === undefined ? undefined : sourceDeletionSchema.parse(raw);
    const retained = prior !== undefined && (!prior.complete || prior.expiresAt > now);
    if (retained && prior.complete) return { status: "ok", removed: 0 };
    const tombstone = sourceDeletionSchema.parse(
      retained ? prior : { address: command.address, deletedAt: now, expiresAt: now + command.ttlMs, complete: false },
    );
    const found = rows
      .list("source-provenance", org, {
        sourceMessage: command.address,
        keyOrder: true,
        ...(tombstone.after ? { afterKey: tombstone.after } : {}),
        limit: ORG_RECONCILE_BATCH_MAX + 1,
      })
      .map((value) => sourceProvenanceSchema.parse(value));
    const selected = found.slice(0, ORG_RECONCILE_BATCH_MAX);
    let removed = 0;
    let allCleared = true;
    for (const value of selected) {
      if (sourceDeletionKey(sourceDeletionAddressOf(value)!) !== key)
        throw new Error("Source deletion address changed.");
      tombstone.expiresAt = Math.max(tombstone.expiresAt, value.retentionDeadline ?? 0);
      const cleared = clearReceiptContent(
        rows,
        org,
        value.receiptId,
        now,
        ORG_RECONCILE_BATCH_MAX - removed,
        command.address,
      );
      removed += cleared.removed;
      if (!cleared.complete) {
        allCleared = false;
        break;
      }
      tombstone.after = value.receiptId;
    }
    tombstone.complete = allCleared && found.length <= ORG_RECONCILE_BATCH_MAX;
    rows.put(
      "source-delete",
      org,
      key,
      sourceDeletionSchema.parse(tombstone),
      tombstone.complete ? "complete" : "pending",
      0,
      tombstone.complete ? tombstone.expiresAt : Number.MAX_SAFE_INTEGER,
    );
    s.revision++;
    if (!retained && found.length) {
      s.accessRevision++;
      s.sourcePolicyRevision++;
    }
    save();
    return tombstone.complete ? { status: "ok", removed } : { status: "busy" };
  }
  if (command.action === "submission") {
    if (!validActor(rows, org, command.actor)) return { status: "fenced" };
    const scope = JSON.stringify([command.source, identityKey(command.actor.identity), command.key]);
    const receipt = rows.get("receipt", org, scope);
    const metadata = rows.get("submission", org, scope);
    if (!receipt || !metadata) return { status: "not_found" };
    return { status: "submission", receipt: receiptSchema.parse(receipt), envelope: envelopeSchema.parse(metadata) };
  }
  if (command.action === "source-catalogue") {
    if (!validActor(rows, org, command.actor) || command.actor.stream === null) return { status: "fenced" };
    const index = rows.get("source-policy-index", org, "version");
    if (index !== 1 && (index !== undefined || s.streamSequence !== 0)) return { status: "unavailable" };
    if (command.after && !command.paged) return { status: "invalid" };
    const retainedOwnPartition = ownPartition(rows, command.actor);
    const candidates = rows
      .list("source-policy", org, {
        partitions: [
          ...new Set([
            command.actor.stream,
            command.actor.principal,
            ...(retainedOwnPartition ? [retainedOwnPartition] : []),
          ]),
        ],
        ...(retainedOwnPartition ? { sourceIdentity: command.actor.identity } : {}),
        limit: command.limit + 1,
        ...(command.paged ? { keyOrder: true, ...(command.after ? { afterKey: command.after } : {}) } : {}),
      })
      .map((row) => sourcePolicySchema.parse(row));
    if (
      candidates.some(
        (row) =>
          (command.actor.bindingRevision === 0 || row.actor.stream !== command.actor.stream) &&
          identityKey(row.actor.identity) !== identityKey(command.actor.identity),
      )
    )
      return { status: "fenced" };
    if (
      (!command.paged && candidates.length > command.limit) ||
      candidates.some((row) => row.authority !== sourceAuthority(row.source, row.actor, row.sourceReference))
    )
      return { status: "unavailable" };
    const selected = candidates.slice(0, command.limit);
    return {
      status: "source-catalogue",
      accessRevision: s.accessRevision,
      ...(command.paged
        ? {
            revision: s.sourcePolicyRevision,
            ...(candidates.length > command.limit
              ? { next: JSON.stringify([selected.at(-1)!.actor.stream, selected.at(-1)!.authority]) }
              : {}),
          }
        : {}),
      entries: selected
        .filter((row) => row.expiresAt > now)
        .map((row) => ({
          authority: row.authority,
          source: row.source,
          actor: row.actor,
          ...(row.sourceReference ? { sourceReference: row.sourceReference } : {}),
          allowed: rows.get("revoked-source", org, identityKey(row.actor.identity)) !== true,
        })),
    };
  }
  if (command.action === "source-policy-observe") {
    if (!validActor(rows, org, command.actor) || command.actor.stream === null) return { status: "fenced" };
    if (command.expectedRevision !== s.sourcePolicyRevision) return { status: "conflict" };
    if (new Set(command.observations.map((row) => row.authority)).size !== command.observations.length)
      return { status: "invalid" };
    const updates = command.observations.map((observation) => {
      const retainedOwnPartition = ownPartition(rows, command.actor);
      const partitions = [
        ...new Set([
          command.actor.stream!,
          command.actor.principal,
          ...(retainedOwnPartition ? [retainedOwnPartition] : []),
        ]),
      ];
      const found = partitions.flatMap((partition) => {
        const key = JSON.stringify([partition, observation.authority]);
        const raw = rows.get("source-policy", org, key);
        return raw === undefined ? [] : [{ key, row: sourcePolicySchema.parse(raw) }];
      });
      if (
        !found.length ||
        found.some(
          ({ row }) =>
            row.expiresAt <= now ||
            row.authority !== sourceAuthority(row.source, row.actor, row.sourceReference) ||
            ((command.actor.bindingRevision === 0 || row.actor.stream !== command.actor.stream) &&
              identityKey(row.actor.identity) !== identityKey(command.actor.identity)),
        )
      )
        return;
      return { observation, found };
    });
    if (updates.some((update) => !update)) return { status: "fenced" };
    let changed = false,
      lost = false;
    for (const update of updates)
      for (const { key, row } of update!.found) {
        const fingerprint = update!.observation.fingerprint;
        if (row.observedFingerprint === fingerprint) continue;
        // Admission establishes allowed access. A first valid observation merely
        // registers its baseline; later policy changes fence retained consumers.
        lost ||= row.observedFingerprint !== undefined || fingerprint === null;
        changed = true;
        rows.put(
          "source-policy",
          org,
          key,
          { ...row, observedFingerprint: fingerprint },
          row.actor.stream!,
          0,
          row.expiresAt,
        );
      }
    if (changed) {
      s.revision++;
      s.sourcePolicyRevision++;
      if (lost) s.accessRevision++;
      save();
    }
    return { status: "source-policies-observed", revision: s.sourcePolicyRevision, accessRevision: s.accessRevision };
  }

  if (command.action === "provenance") {
    if (!validActor(rows, org, command.actor)) return { status: "fenced" };
    const value = rows.get("source-provenance", org, command.receiptId);
    if (!value) return { status: "not_found" };
    const provenance = sourceProvenanceSchema.parse(value);
    if (
      provenance.actor.stream !== command.actor.stream &&
      !(
        (provenance.actor.stream === command.actor.principal || command.actor.stream === command.actor.principal) &&
        identityKey(provenance.actor.identity) === identityKey(command.actor.identity)
      )
    )
      return { status: "not_found" };
    return { status: "provenance", provenance };
  }
  if (command.action === "owner-refused") {
    const scope = rows.get("receipt-key", org, command.receiptId);
    if (typeof scope !== "string") {
      const reservation = command.target
        ? (rows.get("reservation", org, command.target.key) as { receiptId?: string; ownerRunId?: string } | undefined)
        : undefined;
      if (
        reservation?.receiptId === command.receiptId &&
        reservation.ownerRunId === command.ownerRunId &&
        command.target
      ) {
        rows.remove("reservation", org, command.target.key);
        s.revision++;
        save();
        return { status: "ok", removed: 1 };
      }
      return { status: "not_found" };
    }
    const receipt = receiptSchema.parse(rows.get("receipt", org, scope));
    if (receipt.ownerRunId !== command.ownerRunId) return { status: "fenced" };
    if (receipt.status !== "accepted") return { status: "receipt", receipt, duplicate: true };
    if (
      receipt.target &&
      (rows.get("reservation", org, receipt.target) as { receiptId?: string } | undefined)?.receiptId === receipt.id
    )
      rows.remove("reservation", org, receipt.target);
    receipt.status = "rejected";
    receipt.reason = command.reason;
    receipt.settledAt = now;
    rows.put("receipt", org, scope, receiptSchema.parse(receipt), receipt.id, 0, receipt.expiresAt);
    rows.remove("reply-address", org, receipt.id);
    s.revision++;
    save();
    return { status: "receipt", receipt, duplicate: false };
  }
  if (command.action === "owner-clears")
    return {
      status: "owner-clears",
      items: (
        rows.list("owner-clear", org, {
          limit: command.limit,
          ...(command.sourceMessage ? { sourceMessage: command.sourceMessage } : {}),
        }) as { receiptId: string; effectKey: string; expiresAt?: number }[]
      ).map(({ receiptId, effectKey, expiresAt }) => ({
        receiptId,
        effectKey,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      })),
    };
  if (command.action === "owner-cleared") {
    const pending = rows.get("owner-clear", org, command.receiptId) as { effectKey: string } | undefined;
    if (pending && pending.effectKey !== command.effectKey) return { status: "conflict" };
    rows.remove("owner-clear", org, command.receiptId);
    return { status: "ok", removed: pending ? 1 : 0 };
  }
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
  if (command.action === "yield") {
    if (!owns(s, command.owner, command.generation, now)) return { status: "fenced" };
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
        (reconciliation ? p.workload === "reconciliation" : p.workload !== "reconciliation") &&
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
    const sourceDeleted = deletedSource(rows, org, e, now);
    const status = sourceDeleted ? "rejected" : stale ? "stale" : overloaded ? "throttled" : "pending";
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
      reason: sourceDeleted
        ? "Source message deleted."
        : stale
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
    rows.put(
      "submission",
      org,
      scope,
      envelopeSchema.parse({ ...e, content: "", nativeMedia: undefined }),
      "",
      0,
      receipt.expiresAt,
    );
    rows.put(
      "source-provenance",
      org,
      id,
      sourceProvenanceSchema.parse({
        receiptId: id,
        source: e.source,
        actor: e.actor,
        ...(e.sourceReference ? { sourceReference: e.sourceReference } : {}),
        retentionDeadline: Math.max(receipt.expiresAt, now + command.limits.contentTtlMs),
      }),
      "",
      0,
      Math.max(receipt.expiresAt, now + command.limits.contentTtlMs),
    );
    rows.put("receipt-key", org, id, scope);
    if (status === "pending") {
      catalogueSource(rows, s, e, Math.max(receipt.expiresAt, now + command.limits.contentTtlMs));
      if (e.target) rows.put("reservation", org, e.target.key, { revision: e.target.revision, receiptId: id });
      rows.put(
        "pending",
        org,
        id,
        envelopeSchema.parse({
          ...e,
          contentExpiresAt:
            now +
            (e.nativeMedia
              ? Math.min(command.limits.contentTtlMs, command.limits.sourceSnapshotTtlMs ?? command.limits.contentTtlMs)
              : command.limits.contentTtlMs),
        }),
        e.actor.principal,
        s.revision,
        now +
          (e.nativeMedia
            ? Math.min(command.limits.contentTtlMs, command.limits.sourceSnapshotTtlMs ?? command.limits.contentTtlMs)
            : command.limits.contentTtlMs),
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
      deletedSource(rows, org, envelope, now) ||
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
      deletedSource(rows, org, envelope, now) ||
      !validActor(rows, org, envelope.actor)
    ) {
      rejectPending(rows, org, envelope, now, "Access or retention changed.");
      s.revision++;
      save();
      return { status: "receipt", receipt: receiptSchema.parse(rows.get("receipt", org, scope)), duplicate: false };
    }
    s.revision++;
    receipt.status = command.status;
    if (command.ownerRunId) receipt.ownerRunId = command.ownerRunId;
    if (command.status === "accepted" && command.ownerRunId && envelope.target) {
      const reservation = rows.get("reservation", org, envelope.target.key) as
        { receiptId?: string; revision?: number } | undefined;
      if (reservation?.receiptId === receipt.id)
        rows.put("reservation", org, envelope.target.key, { ...reservation, ownerRunId: command.ownerRunId });
    }
    receipt.reason = command.reason;
    receipt.settledAt = now;
    rows.put("receipt", org, scope, receiptSchema.parse(receipt), receipt.id, 0, receipt.expiresAt);
    rows.remove("pending", org, receipt.id);
    if (command.status === "accepted" && command.ownerRunId)
      rows.put(
        "reply-address",
        org,
        receipt.id,
        replyAddressSchema.parse({
          receiptId: receipt.id,
          envelope: { ...envelope, content: "", nativeMedia: undefined, context: [], sourceReference: undefined },
          ownerRunId: command.ownerRunId,
          expiresAt: envelope.contentExpiresAt,
        }),
        "",
        0,
        envelope.contentExpiresAt,
      );
    if (command.status === "rejected") releaseReservation(rows, org, envelope, receipt.id);
    if (command.reply && validActor(rows, org, envelope.actor))
      append(rows, s, envelope, receipt, "assistant", command.reply, now, command.contentTtlMs);
    save();
    return { status: "receipt", receipt, duplicate: false };
  }
  if (command.action === "stream" || command.action === "tail") {
    if (command.actor.stream !== command.stream || !validActor(rows, org, command.actor)) return { status: "fenced" };
    const identities = new Set(command.identities.map(identityKey));
    const reader = identityKey(command.actor.onBehalfOf ?? command.actor.identity);
    const epoch = JSON.stringify([reader, command.actor.bindingRevision]);
    const rawCutoff = rows.get("binding-cutoff", org, epoch) ?? rows.get("binding-cutoff", "", epoch);
    const cutoff = rawCutoff === undefined ? undefined : bindingCutoffSchema.parse(rawCutoff).sequence;
    const retainedOwnPartition = ownPartition(rows, command.actor);
    const partitions = [
      ...new Set([command.stream, command.actor.principal, ...(retainedOwnPartition ? [retainedOwnPartition] : [])]),
    ];
    const candidates = partitions
      .flatMap((partition) =>
        rows
          .list("stream", org, {
            partition,
            ...(partition === retainedOwnPartition ? { sourceIdentity: command.actor.identity } : {}),
            ...(command.action === "tail" ? { before: command.before, descending: true } : { after: command.after }),
            limit: command.limit + 1,
          })
          .map((v) => streamEntrySchema.parse(v)),
      )
      .sort((a, b) => (command.action === "tail" ? b.sequence - a.sequence : a.sequence - b.sequence))
      .slice(0, command.limit + 1);
    const scanned = candidates.slice(0, command.limit);
    const eligible = scanned.filter((entry) => {
      const source = rows.get("source-provenance", org, entry.receiptId);
      if (source !== undefined && deletedSource(rows, org, sourceProvenanceSchema.parse(source), now)) return false;
      if (rows.get("revoked-source", org, identityKey(entry.identity)) === true) return false;
      if (entry.stream !== command.stream && identityKey(entry.identity) !== identityKey(command.actor.identity))
        return false;
      if (
        identityKey(entry.onBehalfOf ?? entry.identity) !== reader &&
        (cutoff === undefined || entry.admissionSequence === undefined || entry.admissionSequence <= cutoff)
      )
        return false;
      if (entry.expiresAt <= now || !identities.has(identityKey(entry.onBehalfOf ?? entry.identity))) return false;
      const binding = rows.binding(entry.onBehalfOf ?? entry.identity);
      return binding.status === "bound"
        ? binding.binding.personId === command.stream
        : binding.status === "unknown" ||
            (binding.status === "revoked" &&
              (entry.stream === command.actor.principal || entry.stream === retainedOwnPartition) &&
              identityKey(entry.identity) === identityKey(command.actor.identity));
    });
    const entries = eligible;
    if (command.action === "tail")
      return {
        status: "stream_tail",
        revision: s.revision,
        entries: entries.reverse(),
        cursor: scanned[0]?.sequence ?? s.streamSequence,
        beforeCursor: scanned.at(-1)?.sequence ?? 0,
        hasMore: candidates.length > scanned.length,
      };
    return {
      status: "stream",
      revision: s.revision,
      entries,
      cursor: scanned.at(-1)?.sequence ?? s.streamSequence,
      hasMore: candidates.length > scanned.length,
    };
  }
  if (command.action === "reply" || command.action === "execution") {
    if (!validActor(rows, org, command.actor)) return { status: "fenced" };
    const address = rows.get("reply-address", org, command.receiptId);
    if (!address) return { status: "not_found" };
    const raw = replyAddressSchema.parse(address);
    const source = rows.get("source-provenance", org, command.receiptId);
    if (source !== undefined && deletedSource(rows, org, sourceProvenanceSchema.parse(source), now))
      return { status: "not_found" };
    if (raw.expiresAt <= now) return { status: "not_found" };
    if (raw.ownerRunId !== command.ownerRunId || JSON.stringify(raw.envelope.actor) !== JSON.stringify(command.actor))
      return { status: "fenced" };
    const scope = rows.get("receipt-key", org, command.receiptId);
    if (typeof scope !== "string") return { status: "not_found" };
    const receipt = receiptSchema.parse(rows.get("receipt", org, scope));
    if (receipt.status !== "accepted") return { status: "fenced" };
    if (command.action === "execution") {
      if (raw.envelope.target && rows.get("target", org, raw.envelope.target.key) !== raw.envelope.target.revision)
        return { status: "stale" };
      return { status: "ok", removed: 0 };
    }
    const key = JSON.stringify([command.receiptId, command.replyKey]);
    const prior = rows.get("reply-key", org, key);
    if (prior !== undefined)
      return replyKeySchema.parse(prior).digest === command.digest
        ? { status: "ok", removed: 0 }
        : { status: "conflict" };
    append(
      rows,
      s,
      raw.envelope,
      receipt,
      "assistant",
      command.content,
      now,
      Math.min(command.contentTtlMs, raw.expiresAt - now),
    );
    rows.put(
      "reply-key",
      org,
      key,
      replyKeySchema.parse({ key, digest: command.digest, expiresAt: raw.expiresAt }),
      "",
      0,
      raw.expiresAt,
    );
    s.revision++;
    save();
    return { status: "ok", removed: 0 };
  }
  if (command.action === "delete") {
    if (command.actor.stream !== command.stream || !validActor(rows, org, command.actor)) return { status: "fenced" };
    const receiptKey = rows.get("receipt-key", org, command.receiptId);
    const original = rows.get("source-provenance", org, command.receiptId);
    let partition = command.stream;
    if (original !== undefined) {
      const provenance = sourceProvenanceSchema.parse(original);
      if (
        (provenance.actor.stream !== command.stream &&
          provenance.actor.stream !== command.actor.principal &&
          command.actor.stream !== command.actor.principal) ||
        identityKey(provenance.actor.identity) !== identityKey(command.actor.identity)
      )
        return { status: "not_found" };
      partition = provenance.actor.stream!;
    }
    if (typeof receiptKey === "string") {
      const receipt = receiptSchema.parse(rows.get("receipt", org, receiptKey));
      if (
        (receipt.actor.stream !== command.stream &&
          receipt.actor.stream !== command.actor.principal &&
          command.actor.stream !== command.actor.principal) ||
        identityKey(receipt.actor.identity) !== identityKey(command.actor.identity)
      )
        return { status: "not_found" };
      partition = receipt.actor.stream!;
      if (receipt.effectKey) {
        const prior = rows.get("owner-clear", org, receipt.id) as
          { effectKey: string; address?: SourceDeletionAddress } | undefined;
        if (prior && prior.effectKey !== receipt.effectKey) throw new Error("Original cleanup owner changed.");
        rows.put("owner-clear", org, receipt.id, {
          receiptId: receipt.id,
          effectKey: receipt.effectKey,
          expiresAt: receipt.expiresAt,
          ...(prior?.address ? { address: prior.address } : {}),
        });
      }
    }
    let removed = 0;
    const address = rows.get("reply-address", org, command.receiptId);
    if (address && (address as { envelope: OrganizationEnvelope }).envelope.actor.stream === partition) {
      rows.remove("reply-address", org, command.receiptId);
    }
    for (const entry of rows
      .list("stream", org, { partition, receiptId: command.receiptId })
      .map((v) => streamEntrySchema.parse(v)))
      if (entry.receiptId === command.receiptId) {
        rows.remove("stream", org, String(entry.sequence));
        removed++;
      }
    // Content deletion also makes queued work ineligible for future model context.
    const raw = rows.get("pending", org, command.receiptId);
    if (raw !== undefined) {
      const e = envelopeSchema.parse(raw);
      if (e.actor.stream === partition) {
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
    if (removed > 0 || raw !== undefined || address !== undefined) {
      s.revision++;
      // Another live owner may still hold this text in its private model seed.
      s.accessRevision++;
      save();
    }
    return { status: "ok", removed };
  }
  let removed = 0;
  let expiredStream = false;
  for (const value of rows.list("reply-address", org, { expiresBefore: now, limit: 1000 }))
    rows.remove("reply-address", org, replyAddressSchema.parse(value).receiptId);
  for (const value of rows.list("reply-key", org, { expiresBefore: now, limit: 1000 }))
    rows.remove("reply-key", org, replyKeySchema.parse(value).key);
  for (const entry of rows
    .list("stream", org, { expiresBefore: now, limit: 1000 })
    .map((v) => streamEntrySchema.parse(v))) {
    rows.remove("stream", org, String(entry.sequence));
    removed++;
    expiredStream = true;
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
    rows.remove("submission", org, scope);
    rows.remove("receipt-key", org, receipt.id);
    removed++;
  }
  if (removed > 0) {
    s.revision++;
    if (expiredStream) s.accessRevision++;
    save();
  }
  let expiredPolicies = false;
  for (const value of rows.list("source-policy", org, { expiresBefore: now, limit: 1000 })) {
    const row = sourcePolicySchema.parse(value);
    rows.remove("source-policy", org, JSON.stringify([row.actor.stream, row.authority]));
    expiredPolicies = true;
  }
  if (expiredPolicies) {
    s.sourcePolicyRevision++;
    save();
  }
  for (const value of rows.list("source-provenance", org, { expiresBefore: now, limit: 1000 }))
    rows.remove("source-provenance", org, sourceProvenanceSchema.parse(value).receiptId);
  for (const value of rows.list("source-delete", org, { partition: "complete", expiresBefore: now, limit: 1000 }))
    rows.remove("source-delete", org, sourceDeletionKey(sourceDeletionSchema.parse(value).address));
  return { status: "ok", removed };
}
