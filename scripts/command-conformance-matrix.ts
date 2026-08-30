// Prints the conformance suite's scenario matrix as Markdown (for a PR body):
//   npx tsx scripts/command-conformance-matrix.ts
// One table per command — rows = the variants src/core/commandConformance.test.ts
// derives from the command's zod schemas, columns = the surfaces it drives —
// plus the cross-cutting assertions applied to every cell. It imports the
// suite's own pure helpers (src/core/testing/, excluded from the build), so
// the matrix cannot drift from the suite; the suite asserts the row count.
import { CommandRegistry, type CommandDef } from "../src/core/commandRegistry.js";
import { registerCoreCommands, type CoreCommandDeps } from "../src/core/commands/all.js";
import { buildConformanceMatrix, renderConformanceMatrix } from "../src/core/testing/commandConformance.js";

const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {} });
registerCoreCommands(registry);
process.stdout.write(renderConformanceMatrix(buildConformanceMatrix(registry.list() as CommandDef<unknown>[])));
