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
export function planForPaths(paths: string[]): ReturnType<typeof fullPlan>;
