// Types for build-stamp.mjs (plain-Node ESM so a Worker's `npm run deploy`
// needs no build step). The runtime shape it produces is read back by
// `src/deploy/buildStamp.ts` (`BuildStamp`).
export type Stamp = { commit: string; builtAt: string };
export const DEFINE_COMMIT: "SWITCHBOARD_BUILD_COMMIT";
export const DEFINE_BUILT_AT: "SWITCHBOARD_BUILT_AT";
export function buildStamp(input: { commit: string; dirty: boolean; now?: Date }): Stamp;
export function defineArgs(stamp: Stamp): string[];
export function spawnOutcome(res: {
  error?: { message: string };
  signal?: NodeJS.Signals | null;
  status?: number | null;
}): { code: number; message?: string };
export function main(extraArgs?: string[]): number;
