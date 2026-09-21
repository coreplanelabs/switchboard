import { installMemoryTestDiagnostics } from "./testDiagnostics.ts";

// Routine Worker logs are not test output. With console interception disabled
// they would flood the runner; keep warnings and errors visible, while tests
// that need a logger inject or spy on one explicitly.
console.log = () => {};
console.info = () => {};
console.debug = () => {};

// Every intentionally detached Worker operation must be registered through
// holdBackgroundTask. Attribute unfinished work, rejected promises and stray
// timers to the case that owned or observed them before another DO pays for it.
installMemoryTestDiagnostics();
