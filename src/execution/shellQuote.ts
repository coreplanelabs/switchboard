/** POSIX single-quote escaping so an arbitrary command survives `bash -c`.
 *  Pure and dependency-free — lives in src/ (inside the root tsconfig's
 *  rootDir) and is imported across packages by the sandbox proxy Worker
 *  (deploy/cloudflare-sandbox/worker.ts; wrangler's bundler follows the
 *  relative import), so the tested code IS the shipped code. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
