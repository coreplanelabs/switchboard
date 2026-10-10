import { identityKey } from "../identity/engine.js";
import { InMemoryPersonDirectory } from "../identity/memory.js";
import type { BindingResolution, ExternalIdentity, PersonDirectory } from "../identity/contract.js";
import {
  commandSchema,
  type OrganizationCommand,
  type OrganizationResult,
  type OrganizationStore,
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
        this.serial(() => {
          this.knownIdentities.set(identityKey(change.identity), change.identity);
          return this.rawDirectory.change(change);
        }),
      receipts: (identity) => this.serial(() => this.rawDirectory.receipts(identity)),
      link: (command) =>
        this.serial(() => {
          this.knownIdentities.set(identityKey(command.auth.identity), command.auth.identity);
          if (command.action === "prove")
            this.knownIdentities.set(identityKey(command.proof.identity), command.proof.identity);
          return this.rawDirectory.link(command);
        }),
    };
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
      const identities: ExternalIdentity[] = [...this.knownIdentities.values()];
      if (command.action === "admit")
        identities.push(command.envelope.actor.onBehalfOf ?? command.envelope.actor.identity);
      if (command.action === "stream") identities.push(...command.identities);
      if (
        command.action === "stream" ||
        command.action === "delete" ||
        command.action === "issue" ||
        command.action === "effect"
      )
        identities.push(command.actor.onBehalfOf ?? command.actor.identity);
      for (const [key, row] of this.rows)
        if ((JSON.parse(key) as string[])[0] === "pending") {
          const actor = (row.value as { actor: { identity: ExternalIdentity; onBehalfOf: ExternalIdentity | null } })
            .actor;
          identities.push(actor.onBehalfOf ?? actor.identity);
        }
      for (const identity of identities) bindings.set(identityKey(identity), await this.rawDirectory.resolve(identity));
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
                (options.partition === undefined || row.partition === options.partition) &&
                (options.after === undefined || row.ordinal > options.after) &&
                (options.expiresBefore === undefined || row.expiry <= options.expiresBefore) &&
                (options.receiptId === undefined ||
                  (row.value as { receiptId?: string }).receiptId === options.receiptId)
              );
            })
            .map(([, row]) => row)
            .sort((a, b) => a.ordinal - b.ordinal)
            .slice(0, options.limit)
            .map((row) => row.value),
        binding: (identity) => bindings.get(identityKey(identity)) ?? { status: "unknown" },
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
