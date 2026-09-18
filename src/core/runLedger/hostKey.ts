// The host key (docs/reference/specs/run-history.md item 29; record 0060): a
// ship pipeline's parent run is claimed on the ledger under its thread key
// plus a `#host` suffix, while the row's metadata names the thread itself —
// the ledger's own occupancy check reads the key column and never sees the
// parent, and everything that lists, files or renders a run reads the metadata
// and finds it under its conversation. One module mints and recognises the
// suffix so the two readings cannot drift apart. Node-free, like types.ts.

/** The marker the host key ends with. `#` cannot appear in a platform thread
 *  key (AGENTS.md invariant 4: `<platform>:<channel>:<ts>`), so no message's
 *  thread can ever equal a host key. */
export const HOST_KEY_SUFFIX = "#host";

/** The ledger's cap on a claim key (the state Worker's `parseClaim`). */
export const LEDGER_KEY_MAX_CHARS = 256;

/** True when `key` is a host key — the claim-column reading of a hosted row. */
export function isHostKey(key: string): boolean {
  return key.endsWith(HOST_KEY_SUFFIX);
}

/** The host key for a thread. Refuses a key that already carries the suffix
 *  (a double host key would un-invert `threadOf`) and one the ledger's
 *  256-character cap could not hold once suffixed — the claim would be
 *  refused there anyway, so the refusal happens here, by name. */
export function hostKeyOf(threadKey: string): string {
  if (isHostKey(threadKey)) throw new Error(`thread key ${threadKey} already carries the ${HOST_KEY_SUFFIX} suffix`);
  const key = `${threadKey}${HOST_KEY_SUFFIX}`;
  if (key.length > LEDGER_KEY_MAX_CHARS)
    throw new Error(
      `thread key ${threadKey.slice(0, 32)}… cannot carry the host suffix: the ledger caps a claim key at ${LEDGER_KEY_MAX_CHARS} characters`,
    );
  return key;
}

/** The thread behind a key: inverts `hostKeyOf`; a plain key is its own thread. */
export function threadOf(key: string): string {
  return isHostKey(key) ? key.slice(0, -HOST_KEY_SUFFIX.length) : key;
}
