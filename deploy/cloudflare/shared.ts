// What the shim's entry and its Workflow both address: the one container
// instance the shim runs (a singleton Durable Object) and the internal origin
// every request into it is written against — the container ignores the host,
// the origin only has to be a URL. Declared apart from worker.ts so
// coordinator.ts reaches them without importing the entry (the binding
// resolves the Workflow's class against worker.ts, which re-exports it: a value
// import the other way would be a cycle).
export const INSTANCE = "singleton";
export const INTERNAL = "https://switchboard-keepalive.internal";
