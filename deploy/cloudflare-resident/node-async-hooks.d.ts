// The one Node API the resident Worker uses (features/tracing.md item 19):
// `AsyncLocalStorage` scopes a request's step trace to that request. Workers
// provide it under `nodejs_compat`; the Worker's tsconfig types only
// `@cloudflare/workers-types`, so the two members used are declared here
// rather than pulling all of `@types/node` into the Worker's own check.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
