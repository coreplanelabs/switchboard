// Imported FIRST by each entry point (src/index.ts, src/cli.ts): ES modules
// evaluate imports in order, so the installation's `.env` is in the
// environment before any module that reads `process.env` at load evaluates.
// The installation is the operator root (src/deploy/operatorRoot.ts): the
// checkout, or — from the published package — SWITCHBOARD_HOME, the cwd when
// it holds an installation, else ~/.switchboard. Nothing on that import path
// reads the environment at load, so the order holds.
import { join } from "node:path";
import { loadEnvFileIfPresent } from "./core/envFile.js";
import { OPERATOR_ROOT } from "./deploy/host.js";

loadEnvFileIfPresent(join(OPERATOR_ROOT.root, ".env"));
