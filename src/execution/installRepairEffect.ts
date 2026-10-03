import { shellQuote } from "./shellQuote.js";

/** The checkout fence is per Durable Object, not per HTTP request. A repair
 * cannot overlap an already running model command, seed, file operation or
 * publication export, and those operations cannot enter until it settles. */
export class CheckoutFence {
  private readers = 0;
  private writer = false;

  shared<T>(operation: () => Promise<T>): Promise<T> {
    if (this.writer) throw new Error("checkout repair in progress");
    this.readers++;
    try {
      return Promise.resolve(operation()).finally(() => this.readers--);
    } catch (error) {
      this.readers--;
      throw error;
    }
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> | null {
    if (this.writer || this.readers) return null;
    this.writer = true;
    try {
      return Promise.resolve(operation()).finally(() => (this.writer = false));
    } catch (error) {
      this.writer = false;
      throw error;
    }
  }
}

/** No request-controlled shell fragment except a validated immutable SHA. The
 * receipt key hashes Git's committed root lockfile tree entry, not disk bytes
 * the model may have changed. A missing/dirty lockfile or moving HEAD refuses
 * the install; the same checks after npm ci refuse an uncertain result. */
export function installRepairCommand(head: string, container?: string): string {
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("invalid repair head");
  if (container !== undefined && !/^[0-9a-f-]{36}$/i.test(container)) throw new Error("invalid repair container");
  const lockfiles = "package-lock.json npm-shrinkwrap.json";
  return [
    "set -eu",
    "cd /workspace/checkout",
    ...(container ? [`test "$(cat /workspace/.switchboard-preservation-incarnation)" = ${shellQuote(container)}`] : []),
    `test "$(git rev-parse HEAD)" = ${shellQuote(head)}`,
    'test -z "$(git status --porcelain -- package.json .npmrc package-lock.json npm-shrinkwrap.json)"',
    `git diff --quiet HEAD -- ${lockfiles}`,
    `entries=$(git ls-tree HEAD -- ${lockfiles})`,
    'test "$(printf "%s\\n" "$entries" | grep -c .)" = 1',
    'key=$(printf "%s\\n" "$entries" | sha256sum | cut -d " " -f1)',
    // The native API has no process timeout option: coreutils bounds the
    // effect and kills its process group before an uncertain outcome returns.
    "timeout -k 10 900 npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1",
    `test "$(git rev-parse HEAD)" = ${shellQuote(head)}`,
    ...(container ? [`test "$(cat /workspace/.switchboard-preservation-incarnation)" = ${shellQuote(container)}`] : []),
    'test -z "$(git status --porcelain -- package.json .npmrc package-lock.json npm-shrinkwrap.json)"',
    `git diff --quiet HEAD -- ${lockfiles}`,
    'test "$(git ls-tree HEAD -- package-lock.json npm-shrinkwrap.json | sha256sum | cut -d " " -f1)" = "$key"',
    'printf "REPAIRED:%s" "$key"',
  ].join("\n");
}
