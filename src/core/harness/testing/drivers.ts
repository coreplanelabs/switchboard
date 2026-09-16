// The drivers the conformance table runs against (docs/reference/specs/harness.md
// item 11): one per harness the tree has. The suite and the matrix script both
// read this list, so neither can name a harness the other does not. pi over its
// fake container and scripted double; OpenCode over a fake `opencode serve`
// driving the real `OpenCodeHarness`. The real-binary OpenCode driver runs the
// same rows against `@opencode/cli` where it is on the PATH (a devDependency in
// CI); it is added only there, so a machine without the binary still runs the
// full table over the fake serve.

import { piDriver } from "../pi/testing/driver.js";
import { openCodeDriver } from "../opencode/testing/driver.js";
import type { HarnessDriver } from "./scenarios.js";

export function harnessDrivers(): HarnessDriver[] {
  return [piDriver(), openCodeDriver()];
}
