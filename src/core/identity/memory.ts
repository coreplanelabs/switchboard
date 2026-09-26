import {
  changeSchema,
  identitySchema,
  type BindingChange,
  type BindingReceipt,
  type BindingResolution,
  type ChangeResult,
  type CreatePersonResult,
  type ExternalIdentity,
  type Person,
  type PersonBinding,
  type PersonDirectory,
  type ReceiptsResult,
} from "./contract.js";
import type { LinkAudit, LinkCommand, LinkIntent, LinkResult } from "./linkContract.js";
import { executeLink } from "./linkEngine.js";
import { decideChange, identityKey, mintPerson, readBinding, readReceipts, resolution } from "./engine.js";

/** Test/dev implementation. Every mutation is synchronous before its promise
 * resolves; no caller gets a reference to the stored mutable objects. */
export class InMemoryPersonDirectory implements PersonDirectory {
  private state = {
    people: new Map<string, Person>(),
    bindings: new Map<string, PersonBinding>(),
    history: new Map<string, BindingReceipt[]>(),
    intents: new Map<string, LinkIntent>(),
    audits: new Map<string, LinkAudit>(),
  };
  constructor(private readonly now: () => number) {}

  async createPerson(): Promise<CreatePersonResult> {
    try {
      const person = mintPerson(this.now());
      if (this.state.people.has(person.id)) return { status: "unavailable" };
      this.state.people.set(person.id, { ...person });
      return { status: "created", person };
    } catch {
      return { status: "unavailable" };
    }
  }
  async resolve(identity: ExternalIdentity): Promise<BindingResolution> {
    const parsed = identitySchema.safeParse(identity);
    if (!parsed.success) return { status: "invalid" };
    return resolution(
      readBinding(this.state.bindings.get(identityKey(parsed.data)), parsed.data, (id) => this.state.people.has(id)),
    );
  }
  async change(input: BindingChange): Promise<ChangeResult> {
    const parsed = changeSchema.safeParse(input);
    if (!parsed.success) return { status: "invalid" };
    const change = parsed.data;
    try {
      const key = identityKey(change.identity);
      const current = readBinding(this.state.bindings.get(key), change.identity, (id) => this.state.people.has(id));
      if (current.status === "conflict") return current;
      if (!this.state.people.has(change.personId)) return { status: "unknown_person" };
      const result = decideChange(current, change, this.now());
      if (result.status === "changed") {
        const receipt = structuredClone({ action: change.action, actor: change.actor, binding: result.binding });
        this.state.bindings.set(key, receipt.binding);
        this.state.history.set(key, [...(this.state.history.get(key) ?? []), receipt]);
      }
      return result;
    } catch {
      return { status: "unavailable" };
    }
  }
  async link(command: LinkCommand): Promise<LinkResult> {
    try {
      // Copy-on-write: even a failure on the last audit write publishes nothing.
      // Existing map values are never mutated by the shared engine.
      const next = {
        people: new Map(this.state.people),
        bindings: new Map(this.state.bindings),
        history: new Map(this.state.history),
        intents: new Map(this.state.intents),
        audits: new Map(this.state.audits),
      };
      const result = executeLink(
        {
          intent: (id) => next.intents.get(id),
          audit: (id) => next.audits.get(id),
          current: (identity) =>
            readBinding(next.bindings.get(identityKey(identity)), identity, (id) => next.people.has(id)),
          putIntent: (intent, create) => {
            if (create && next.intents.has(intent.id)) throw new Error("duplicate intent");
            next.intents.set(intent.id, intent);
          },
          putPerson: (person) => {
            if (next.people.has(person.id)) throw new Error("duplicate person");
            next.people.set(person.id, person);
          },
          putBinding: (receipt) => {
            const key = identityKey(receipt.binding.identity);
            next.bindings.set(key, receipt.binding);
            next.history.set(key, [...(next.history.get(key) ?? []), receipt]);
          },
          putAudit: (audit) => {
            if (next.audits.has(audit.id)) throw new Error("duplicate outcome");
            next.audits.set(audit.id, audit);
          },
        },
        command,
        this.now(),
      );
      const detached = structuredClone(result);
      this.state = next;
      return detached;
    } catch {
      return { status: "unavailable" };
    }
  }
  async receipts(identity: ExternalIdentity): Promise<ReceiptsResult> {
    const parsed = identitySchema.safeParse(identity);
    if (!parsed.success) return { status: "invalid" };
    return readReceipts(this.state.history.get(identityKey(parsed.data)) ?? [], parsed.data);
  }
}
