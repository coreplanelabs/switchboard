import { PACKAGE_ROOT, RUNS_FROM_PUBLISHED_PACKAGE } from "../packageRoot.js";
import { resolveOperatorRoot, type OperatorRoot } from "./operatorRoot.js";

// The root this process deploys from — the one place the deploy hosts
// (src/deploy/run.ts, src/deploy/secretsHost.ts) ask "where"
// (src/deploy/operatorRoot.ts explains the three kinds of file).

/** Where this process deploys from: the package root and the working directory it was started in. */
export const OPERATOR_ROOT: OperatorRoot = resolveOperatorRoot({
  packageRoot: PACKAGE_ROOT,
  published: RUNS_FROM_PUBLISHED_PACKAGE,
  cwd: process.cwd(),
});
