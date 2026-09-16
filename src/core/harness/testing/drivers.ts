// The drivers the conformance table runs against (docs/reference/specs/harness.md
// item 11): one per harness the tree has. pi's is the only one today; a second
// harness adds its driver here and the same rows judge it. The suite and the
// matrix script both read this list, so neither can name a harness the other
// does not.

import { piDriver } from "../pi/testing/driver.js";
import type { HarnessDriver } from "./scenarios.js";

export function harnessDrivers(): HarnessDriver[] {
  return [piDriver()];
}
