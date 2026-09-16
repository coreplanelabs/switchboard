// Prints the harness conformance matrix as Markdown (for a PR body), running
// every row of the table against every harness driver the tree has:
//   npx tsx scripts/harness-conformance-matrix.ts
// Rows are record 0038's six clauses and the parity rows
// (src/core/harness/testing/scenarios.ts), columns the drivers
// (src/core/harness/testing/drivers.ts); a harness named here without a driver
// shows as absent. It imports the suite's own table and renderer, so the
// matrix cannot drift from src/core/harness/conformance.test.ts.
import { harnessDrivers } from "../src/core/harness/testing/drivers.js";
import {
  buildHarnessConformanceMatrix,
  renderHarnessConformanceMatrix,
} from "../src/core/harness/testing/scenarios.js";

const columns = await buildHarnessConformanceMatrix(harnessDrivers());
process.stdout.write(renderHarnessConformanceMatrix(columns, ["pi", "opencode"]));
