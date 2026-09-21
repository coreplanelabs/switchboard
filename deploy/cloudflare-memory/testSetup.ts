import { afterEach } from "vitest";
import { assertNoPendingBackgroundTasks } from "./backgroundTasks.ts";

// Routine Worker logs are not test output. With console interception disabled
// they would flood the runner; keep warnings and errors visible, while tests
// that need a logger inject or spy on one explicitly.
console.log = () => {};
console.info = () => {};
console.debug = () => {};

// Every intentionally detached Worker operation must be registered through
// holdBackgroundTask. Fail its own case rather than letting workerd charge its
// unfinished work to a later Durable Object request in the shared isolate.
afterEach(() => assertNoPendingBackgroundTasks());
