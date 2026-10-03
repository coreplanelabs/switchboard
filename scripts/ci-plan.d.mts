export const BOT_CHECKS: string[];
export const WORKERS: string[];
export const IMAGES: string[];
export function baseForEvent(name: string | undefined, event: unknown): string | undefined;
export function fullPlan(): {
  botChecks: string[];
  botTests: boolean;
  web: boolean;
  docs: boolean;
  package: boolean;
  workers: string[];
  images: string[];
};
export function fixtureRegistrationOnly(
  beforePackage: string | undefined,
  afterPackage: string | undefined,
  beforeLock: string | undefined,
  afterLock: string | undefined,
): boolean;
export function planForPaths(
  paths: string[],
  options?: { fixtureRegistrationOnly?: boolean },
): ReturnType<typeof fullPlan>;
export function planForDiff(
  paths: string[],
  beforePackage: string | undefined,
  afterPackage: string | undefined,
  beforeLock: string | undefined,
  afterLock: string | undefined,
): ReturnType<typeof fullPlan>;
