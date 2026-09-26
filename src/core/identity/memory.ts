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
import { decideChange, identityKey, mintPerson, readBinding, readReceipts, resolution } from "./engine.js";

/** Test/dev implementation. Every mutation is synchronous before its promise
 * resolves; no caller gets a reference to the stored mutable objects. */
export class InMemoryPersonDirectory implements PersonDirectory {
  private state = {
    people: new Map<string, Person>(),
    bindings: new Map<string, PersonBinding>(),
    history: new Map<string, BindingReceipt[]>(),
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
  async receipts(identity: ExternalIdentity): Promise<ReceiptsResult> {
    const parsed = identitySchema.safeParse(identity);
    if (!parsed.success) return { status: "invalid" };
    return readReceipts(this.state.history.get(identityKey(parsed.data)) ?? [], parsed.data);
  }
}
