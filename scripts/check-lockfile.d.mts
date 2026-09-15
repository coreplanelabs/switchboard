export const REQUIRED_VARIANTS: Record<string, string[]>;
export function missingVariants(
  packagePaths: string[],
  required?: Record<string, string[]>,
): { family: string; variant: string }[];

/** A package.json or a lockfile `packages[…]` record: the fields npm mirrors, loosely typed. */
export type PackageRecord = Record<string, unknown>;

export const MIRRORED_FIELDS: string[];
/** Either side may be absent: an unread manifest or a record npm never wrote
 *  compares as having none of the mirrored fields. */
export function manifestDrift(
  manifest: PackageRecord | undefined,
  record: PackageRecord | undefined,
  fields?: string[],
): { field: string; manifest: unknown; lockfile: unknown }[];
export function recordsToMirror(
  rootManifest: PackageRecord,
  lock: { packages?: Record<string, PackageRecord> },
  readManifest: (dir: string) => PackageRecord | undefined,
): { path: string; manifest: PackageRecord | undefined; record: PackageRecord | undefined }[];

/** The record path a dependant's edge resolves to, nested before hoisted, a workspace link followed. */
export function resolveDependency(
  packages: Record<string, PackageRecord>,
  from: string,
  name: string,
): { path: string; record: PackageRecord } | undefined;

export type ResolutionProblem =
  | { kind: "unsatisfied"; from: string; field: string; name: string; spec: string; at: string; version: unknown }
  | { kind: "missing"; from: string; field: string; name: string; spec: string }
  | { kind: "unpinned"; at: string; version: unknown };
/** Edges the lock declares that npm cannot honour, and fetched records it cannot pin — in lock order. */
export function resolutionProblems(lock: { packages?: Record<string, PackageRecord> }): ResolutionProblem[];
