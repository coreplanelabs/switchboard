import { identityKey } from "../identity/engine.js";
import { InMemoryPersonDirectory } from "../identity/memory.js";
import type { BindingResolution, ExternalIdentity, PersonDirectory } from "../identity/contract.js";
import {
  commandSchema,
  type OrganizationCommand,
  type OrganizationResult,
  type OrganizationStore,
  stateSchema,
  bindingCutoffSchema,
} from "./contract.js";
import { executeOrganization, type OrganizationRows } from "./engine.js";

export class InMemoryOrganizationStore implements OrganizationStore {
  private rows = new Map<string, { value: unknown; partition: string; ordinal: number; expiry: number }>();
  private readonly knownIdentities = new Map<string, ExternalIdentity>();
  private tail: Promise<unknown> = Promise.resolve();
  readonly directory: PersonDirectory;
  private readonly rawDirectory: InMemoryPersonDirectory;
  constructor(private readonly now: () => number) {
    this.rawDirectory = new InMemoryPersonDirectory(now);
    this.directory = {
      createPerson: () => this.serial(() => this.rawDirectory.createPerson()),
      resolve: (identity) =>
        this.serial(() => {
          this.knownIdentities.set(identityKey(identity), identity);
          return this.rawDirectory.resolve(identity);
        }),
      change: (change) =>
        this.serial(async () => {
          const snapshots = this.cutoffSnapshots();
          this.knownIdentities.set(identityKey(change.identity), change.identity);
          const result = await this.rawDirectory.change(change);
          if (result.status === "changed") {
            if (result.binding.state === "active")
              this.stampCutoff(change.identity, result.binding.revision, snapshots);
            this.advanceBindingProjection();
          }
          return result;
        }),
      receipts: (identity) => this.serial(() => this.rawDirectory.receipts(identity)),
      link: (command) =>
        this.serial(async () => {
          const snapshots = this.cutoffSnapshots();
          this.knownIdentities.set(identityKey(command.auth.identity), command.auth.identity);
          if (command.action === "prove")
            this.knownIdentities.set(identityKey(command.proof.identity), command.proof.identity);
          const before = new Map<string, number>();
          for (const identity of this.knownIdentities.values()) {
            const resolved = await this.rawDirectory.resolve(identity);
            if (resolved.status === "bound") before.set(identityKey(identity), resolved.binding.revision);
            else if (resolved.status === "revoked") before.set(identityKey(identity), resolved.revision);
          }
          const result = await this.rawDirectory.link(command);
          if (result.status === "committed")
            for (const identity of this.knownIdentities.values()) {
              const resolved = await this.rawDirectory.resolve(identity);
              const revision =
                resolved.status === "bound"
                  ? resolved.binding.revision
                  : resolved.status === "revoked"
                    ? resolved.revision
                    : undefined;
              if (revision !== undefined && before.get(identityKey(identity)) !== revision) {
                if (resolved.status === "bound") this.stampCutoff(identity, revision, snapshots);
                this.advanceBindingProjection();
              }
            }
          return result;
        }),
    };
  }
  private cutoffSnapshots() {
    return [...this.rows]
      .filter(([key]) => (JSON.parse(key) as string[])[0] === "state")
      .map(([, row]) => stateSchema.parse(row.value));
  }
  private advanceBindingProjection() {
    for (const snapshot of this.cutoffSnapshots()) {
      const key = JSON.stringify(["state", snapshot.organization, "state"]);
      const row = this.rows.get(key)!;
      snapshot.revision++;
      snapshot.accessRevision++;
      this.rows.set(key, { ...row, value: stateSchema.parse(snapshot) });
    }
  }
  private stampCutoff(
    identity: ExternalIdentity,
    revision: number,
    snapshots: ReturnType<InMemoryOrganizationStore["cutoffSnapshots"]>,
  ): void {
    const epoch = JSON.stringify([identityKey(identity), revision]);
    const write = (organization: string, sequence: number) => {
      const key = JSON.stringify(["binding-cutoff", organization, epoch]);
      if (!this.rows.has(key))
        this.rows.set(key, {
          value: bindingCutoffSchema.parse({ version: 1, sequence }),
          partition: "",
          ordinal: 0,
          expiry: Number.MAX_SAFE_INTEGER,
        });
    };
    write("", 0);
    for (const state of snapshots) write(state.organization, state.streamSequence);
  }
  private serial<T>(body: () => Promise<T>): Promise<T> {
    const next = this.tail.then(body, body);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  execute(command: OrganizationCommand): Promise<OrganizationResult> {
    return this.serial(async () => {
      if (!commandSchema.safeParse(command).success) return { status: "invalid" };
      const bindings = new Map<string, BindingResolution>();
      const retainedPartitions = new Map<string, { revision: number; personId: string }>();
      const identities: ExternalIdentity[] = [...this.knownIdentities.values()];
      if (command.action === "admit")
        identities.push(command.envelope.actor.onBehalfOf ?? command.envelope.actor.identity);
      if (command.action === "stream" || command.action === "tail") identities.push(...command.identities);
      if (
        command.action === "stream" ||
        command.action === "tail" ||
        command.action === "delete" ||
        command.action === "issue" ||
        command.action === "effect" ||
        command.action === "reply" ||
        command.action === "execution" ||
        command.action === "submission" ||
        command.action === "provenance" ||
        command.action === "source-catalogue" ||
        command.action === "source-policy-observe"
      )
        identities.push(command.actor.onBehalfOf ?? command.actor.identity);
      for (const [key, row] of this.rows)
        if ((JSON.parse(key) as string[])[0] === "pending") {
          const actor = (row.value as { actor: { identity: ExternalIdentity; onBehalfOf: ExternalIdentity | null } })
            .actor;
          identities.push(actor.onBehalfOf ?? actor.identity);
        }
      for (const identity of identities) {
        const current = await this.rawDirectory.resolve(identity);
        bindings.set(identityKey(identity), current);
        if (current.status === "revoked") {
          const receipts = await this.rawDirectory.receipts(identity);
          const last = receipts.status === "ok" ? receipts.receipts.at(-1)?.binding : undefined;
          if (!last || last.state !== "revoked" || last.revision !== current.revision) return { status: "unavailable" };
          retainedPartitions.set(identityKey(identity), { revision: current.revision, personId: last.personId });
        }
      }
      const next = structuredClone(this.rows);
      const key = (kind: string, org: string, id: string) => JSON.stringify([kind, org, id]);
      const rows: OrganizationRows = {
        get: (kind, org, id) => next.get(key(kind, org, id))?.value,
        put: (kind, org, id, value, partition = "", ordinal = 0, expiry = Number.MAX_SAFE_INTEGER) => {
          next.set(key(kind, org, id), { value: structuredClone(value), partition, ordinal, expiry });
        },
        remove: (kind, org, id) => {
          next.delete(key(kind, org, id));
        },
        list: (kind, org, options = {}) =>
          [...next]
            .filter(([encoded, row]) => {
              const tuple = JSON.parse(encoded) as string[];
              return (
                tuple[0] === kind &&
                tuple[1] === org &&
                (options.sourceIdentity === undefined ||
                  identityKey(
                    kind === "stream"
                      ? (row.value as { identity: ExternalIdentity }).identity
                      : (row.value as { actor: { identity: ExternalIdentity } }).actor.identity,
                  ) === identityKey(options.sourceIdentity)) &&
                (options.partition === undefined || row.partition === options.partition) &&
                (options.partitions === undefined || options.partitions.includes(row.partition)) &&
                (options.afterKey === undefined ||
                  Buffer.compare(Buffer.from(tuple[2]!), Buffer.from(options.afterKey)) > 0) &&
                (options.after === undefined || row.ordinal > options.after) &&
                (options.before === undefined || row.ordinal < options.before) &&
                (options.expiresBefore === undefined || row.expiry <= options.expiresBefore) &&
                (options.receiptId === undefined ||
                  (row.value as { receiptId?: string }).receiptId === options.receiptId)
              );
            })
            .sort(([encodedA, a], [encodedB, b]) =>
              options.keyOrder
                ? Buffer.compare(
                    Buffer.from((JSON.parse(encodedA) as string[])[2]!),
                    Buffer.from((JSON.parse(encodedB) as string[])[2]!),
                  )
                : options.descending
                  ? b.ordinal - a.ordinal
                  : a.ordinal - b.ordinal,
            )
            .slice(0, options.limit)
            .map(([, row]) => row.value),
        binding: (identity) => bindings.get(identityKey(identity)) ?? { status: "unknown" },
        ownPartition: (identity, revision) => {
          const stored = retainedPartitions.get(identityKey(identity));
          return stored?.revision === revision ? stored.personId : undefined;
        },
        identities: (personId) =>
          [...bindings.values()].flatMap((binding) =>
            binding.status === "bound" && binding.binding.personId === personId ? [binding.binding.identity] : [],
          ),
      };
      try {
        const result = executeOrganization(rows, command, this.now());
        this.rows = next;
        return structuredClone(result);
      } catch {
        return { status: "unavailable" };
      }
    });
  }
}
