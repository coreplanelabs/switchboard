// Imported FIRST by each entry point (src/index.ts, src/cli.ts): ES modules
// evaluate imports in order, so the `.env` in the working directory is in the
// environment before any module that reads `process.env` at load evaluates.
import { loadEnvFileIfPresent } from "./core/envFile.js";

loadEnvFileIfPresent();
