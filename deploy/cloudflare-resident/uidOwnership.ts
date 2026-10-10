import { isResidentPoolUser, parseSpentPoolUsers } from "../../src/execution/residentPoolSpends.js";

type Store = Pick<DurableObjectTransaction, "get" | "put" | "list">;
type State = { generation: string; next: number; issued: number };
const STATE = "uid:state";
const LEGACY = "resident:spentPoolUsers";
const userKey = (state: State, user: string) => `uid:${state.generation}:user:${user}`;
const ownerKey = async (state: State, owner: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `uid:${state.generation}:owner:${hash}`;
};
const validOwner = (owner: string) => /^(thread|op):\S+$/.test(owner);

/** Called inside the existing storage transaction. Legacy ownership is
 * indexed once; absent or corrupt state never becomes an empty generation. */
async function stateOf(tx: Store): Promise<State> {
  const raw = await tx.get<State>(STATE);
  if (raw !== undefined) {
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.generation !== "string" ||
      !raw.generation ||
      !Number.isSafeInteger(raw.next) ||
      raw.next < 2 ||
      raw.next > 2_147_481_648 ||
      !Number.isSafeInteger(raw.issued) ||
      raw.issued < 0 ||
      raw.issued > raw.next - 2
    )
      throw new Error("UID generation is unverified");
    return raw;
  }
  const legacy = parseSpentPoolUsers(await tx.get(LEGACY));
  if (!legacy) throw new Error("UID generation is unverified");
  // The legacy image precreated worker2..worker33. An unspent ledger entry
  // alone cannot prove one of those accounts has never acquired private state.
  // A new object starts at worker2 only after confirmed destruction;
  // later recreations retain allocation high-water and surviving bindings.
  const state: State = { generation: crypto.randomUUID(), next: 34, issued: legacy.size };
  for (const [user, owner] of legacy) {
    await tx.put(userKey(state, user), owner);
    const key = await ownerKey(state, owner);
    if ((await tx.get(key)) === undefined) await tx.put(key, { owner, user });
    state.next = Math.max(state.next, Number(user.slice(6)) + 1);
  }
  await tx.put(STATE, state);
  return state;
}

/** Reserve before native account creation. A failed creation retains the
 * same identity for its owner; another owner always receives a fresh UID. */
export async function reserveUid(tx: Store, owner: string): Promise<string> {
  if (!validOwner(owner)) throw new Error("UID owner is invalid");
  const state = await stateOf(tx);
  const key = await ownerKey(state, owner);
  const prior = await tx.get<{ owner: string; user: string }>(key);
  if (prior !== undefined) {
    if (
      !prior ||
      prior.owner !== owner ||
      !isResidentPoolUser(prior.user) ||
      (await tx.get(userKey(state, prior.user))) !== owner
    )
      throw new Error("UID ownership is unverified");
    return prior.user;
  }
  const user = `worker${state.next}`;
  if (!isResidentPoolUser(user)) throw new Error("Native UID range is exhausted");
  if ((await tx.get(userKey(state, user))) !== undefined) throw new Error("UID allocation counter is inconsistent");
  await tx.put(userKey(state, user), owner);
  await tx.put(key, { owner, user });
  await tx.put(STATE, { ...state, next: state.next + 1, issued: state.issued + 1 });
  return user;
}

export async function uidOwner(tx: Store, user: string): Promise<string | null> {
  if (!isResidentPoolUser(user)) return null;
  const value = await tx.get<unknown>(userKey(await stateOf(tx), user));
  if (value === undefined) return null;
  if (typeof value !== "string" || !validOwner(value)) throw new Error("UID ownership is unverified");
  return value;
}

/** Claim a legacy retained identity only through the same owner check.
 * A historical binding cannot overwrite another indexed owner. */
export async function claimUid(tx: Store, user: string, owner: string): Promise<boolean> {
  if (!isResidentPoolUser(user) || !validOwner(owner)) return false;
  const state = await stateOf(tx);
  const key = userKey(state, user);
  const prior = await tx.get<unknown>(key);
  if (prior !== undefined) return prior === owner;
  await tx.put(key, owner);
  const byOwner = await ownerKey(state, owner);
  if ((await tx.get(byOwner)) === undefined) await tx.put(byOwner, { owner, user });
  await tx.put(STATE, { ...state, next: Math.max(state.next, Number(user.slice(6)) + 1), issued: state.issued + 1 });
  return true;
}

/** Reporting and legacy classification may enumerate a generation. Shell
 * authorization uses uidOwner's one indexed read instead. */
export async function uidLedger(tx: Store, maximum = Infinity): Promise<ReadonlyMap<string, string>> {
  const state = await stateOf(tx);
  const prefix = `uid:${state.generation}:user:`;
  const result = new Map<string, string>();
  let startAfter: string | undefined;
  for (;;) {
    const rows = await tx.list<unknown>({
      prefix,
      limit: Math.min(1000, maximum - result.size),
      ...(startAfter ? { startAfter } : {}),
    });
    for (const [key, owner] of rows) {
      const user = key.slice(prefix.length);
      if (!isResidentPoolUser(user) || typeof owner !== "string" || !validOwner(owner))
        throw new Error("UID ownership is unverified");
      result.set(user, owner);
      startAfter = key;
    }
    if (rows.size < 1000 || result.size >= maximum) break;
  }
  if (maximum >= state.issued && result.size !== state.issued) throw new Error("UID count is inconsistent");
  return result;
}

export async function issuedUidCount(tx: Store): Promise<number> {
  return (await stateOf(tx)).issued;
}

/** Only the confirmed native-destruction caller may rotate generations.
 * Older indexed rows remain evidence and cannot authorize the new VM. */
export async function resetUidGeneration(tx: Store): Promise<void> {
  const prior = await tx.get(STATE);
  const legacy = await tx.get(LEGACY);
  let next = prior !== undefined || legacy !== undefined ? (await stateOf(tx)).next : 2;
  // Bindings survive a VM reset, including legacy bindings absent from the
  // ledger. Reserve their numeric identities before any new owner is admitted.
  let startAfter: string | undefined;
  for (;;) {
    const rows = await tx.list<{ user?: unknown; evicted?: unknown }>({
      prefix: "thread:",
      limit: 1000,
      ...(startAfter ? { startAfter } : {}),
    });
    for (const [key, binding] of rows) {
      startAfter = key;
      if (binding?.evicted === true || binding?.user === "") continue;
      if (!binding || typeof binding.user !== "string" || !isResidentPoolUser(binding.user))
        throw new Error("Retained UID is unverified");
      next = Math.max(next, Number(binding.user.slice(6)) + 1);
    }
    if (rows.size < 1000) break;
  }
  await tx.put(LEGACY, []);
  await tx.put(STATE, { generation: crypto.randomUUID(), next, issued: 0 } satisfies State);
}
