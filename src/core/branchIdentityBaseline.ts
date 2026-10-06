// Feature: docs/reference/specs/run-history.md — durable branch identity baseline.
import type { BranchStartState } from "./branchStartState.js";
import { isPublicationRepo } from "./branchPublication.js";
import { IDEMPOTENCY_KEY_PATTERN, INSTANCE_ID_PATTERN, RUN_ID_PATTERN } from "./runIdentity.js";

/** The identity rewrite already refuses ranges above this commit count. */
export const BRANCH_IDENTITY_BASELINE_MAX_COMMITS = 300;
export const BRANCH_IDENTITY_BASELINE_MAX_BYTES = 64 * 1024;

/** The first attached branch's identity evidence, retained by its original run. */
export interface BranchIdentityBaseline {
  version: 1;
  binding: {
    runId: string;
    requester: string;
    threadKey: string;
    repo: string;
    branch: string;
    base: string;
    head: string;
    instanceId?: string;
    step?: string;
  };
  state: BranchStartState;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const text = (value: unknown, max = 1024): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const head = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const ref = (value: unknown): value is string =>
  text(value, 255) && /^(?![-/.])(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*[/.]$)(?!.*@\{)[A-Za-z0-9._/-]+$/.test(value);

function isBinding(value: unknown): value is BranchIdentityBaseline["binding"] {
  if (
    !object(value) ||
    !keys(value, ["runId", "requester", "threadKey", "repo", "branch", "base", "head"], ["instanceId", "step"]) ||
    typeof value.runId !== "string" ||
    !RUN_ID_PATTERN.test(value.runId) ||
    !text(value.requester) ||
    !text(value.threadKey) ||
    !isPublicationRepo(value.repo) ||
    !ref(value.branch) ||
    !ref(value.base) ||
    !head(value.head)
  )
    return false;
  if (Object.hasOwn(value, "instanceId") !== Object.hasOwn(value, "step")) return false;
  return (
    !Object.hasOwn(value, "instanceId") ||
    (typeof value.instanceId === "string" &&
      INSTANCE_ID_PATTERN.test(value.instanceId) &&
      typeof value.step === "string" &&
      IDEMPOTENCY_KEY_PATTERN.test(value.step) &&
      value.step.startsWith(`${value.instanceId}:`))
  );
}

function isStartState(value: unknown): value is BranchStartState {
  if (!object(value)) return false;
  if (value.kind === "unknown")
    return keys(value, ["kind"], ["reason"]) && (!Object.hasOwn(value, "reason") || text(value.reason));
  if (value.kind === "boundary")
    return keys(value, ["kind", "sha"]) && typeof value.sha === "string" && /^[a-f0-9]{4,40}$/.test(value.sha);
  if (
    value.kind !== "known" ||
    !keys(value, ["kind", "commits"]) ||
    !Array.isArray(value.commits) ||
    value.commits.length > BRANCH_IDENTITY_BASELINE_MAX_COMMITS
  )
    return false;
  const seen = new Set<string>();
  return value.commits.every((commit: unknown) => {
    if (
      !object(commit) ||
      !keys(commit, ["sha", "author", "date", "message"]) ||
      !head(commit.sha) ||
      seen.has(commit.sha) ||
      !object(commit.author) ||
      !keys(commit.author, ["name", "email"]) ||
      !text(commit.author.name) ||
      !text(commit.author.email) ||
      !text(commit.date, 128) ||
      typeof commit.message !== "string"
    )
      return false;
    seen.add(commit.sha);
    return true;
  });
}

/** Unknown is durable evidence of failure, never a known empty start state. */
export function isBranchIdentityBaseline(value: unknown): value is BranchIdentityBaseline {
  if (
    !object(value) ||
    !keys(value, ["version", "binding", "state"]) ||
    value.version !== 1 ||
    !isBinding(value.binding) ||
    !isStartState(value.state)
  )
    return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= BRANCH_IDENTITY_BASELINE_MAX_BYTES;
  } catch {
    return false;
  }
}

/** A restart may advance the attached head; it cannot replace the original identity binding. */
export function branchIdentityBaselineFor(
  value: unknown,
  binding: Omit<BranchIdentityBaseline["binding"], "head"> & { head?: string },
): BranchIdentityBaseline | undefined {
  if (!isBranchIdentityBaseline(value) || !isBinding({ ...binding, head: binding.head ?? value.binding.head })) return;
  const fields = ["runId", "requester", "threadKey", "repo", "branch", "base", "instanceId", "step"] as const;
  if (fields.some((field) => value.binding[field] !== binding[field])) return;
  return structuredClone(value);
}
