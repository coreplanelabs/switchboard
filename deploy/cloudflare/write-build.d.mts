// Types for write-build.mjs (plain-Node ESM so the bot's `npm run deploy` needs
// no build step). The file it writes is what `src/index.ts` reads as `BuildInfo`.
export type BuildInfo = { commit: string; builtAt: string };
export const COMMIT_ENV: "SWITCHBOARD_BUILD_COMMIT";
export function buildInfo(input: { commit: string; dirty: boolean; now?: Date }): BuildInfo;
export function readBuildInfo(env?: Record<string, string | undefined>, git?: (args: string[]) => string): BuildInfo;
export function main(): number;
