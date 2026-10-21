import { z } from "zod";
import type { Read } from "./sandboxLiveGate.js";

/** Intent belongs to this upload, not whichever rollout happens to be active. */
export interface DeploymentIntent {
  /** Bound by the runner to its frozen account before host I/O. */
  account?: string;
  script: string;
  versionId: string;
  since: number;
  container?: { application: string; beforeVersion?: number; image?: string | null };
  rolloutId?: string;
}

export interface DeploymentStatus {
  state: "waiting" | "ready" | "failed";
  reason: string;
  rolloutId?: string;
}

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const deploymentSchema = z.object({
  deployments: z
    .array(
      z.object({
        id: identifier,
        created_on: z.iso.datetime({ offset: true }),
        versions: z.array(z.object({ version_id: identifier, percentage: z.number().min(0).max(100) })),
      }),
    )
    .min(1),
});
const rolloutSchema = z.object({
  id: identifier,
  created_at: z.iso.datetime({ offset: true }),
  current_version: z.number().int().nonnegative(),
  target_version: z.number().int().nonnegative(),
  target_configuration: z.object({ image: z.string().min(1).optional() }),
  status: z.enum(["pending", "progressing", "completed", "reverted", "replaced"]),
  progress: z
    .object({
      current_step: z.number().int().nonnegative(),
      total_steps: z.number().int().nonnegative(),
      updated_instances: z.number().int().nonnegative(),
      total_instances: z.number().int().nonnegative(),
    })
    .optional(),
  health: z.object({ errors: z.array(z.unknown()) }),
});

/** Only GET paths under the selected account; callers retain auth and cancellation. */
export async function readCloudflareDeployment(
  intent: DeploymentIntent,
  get: (path: string) => Promise<Read<unknown>>,
): Promise<DeploymentStatus> {
  const worker = await get(`/workers/scripts/${encodeURIComponent(intent.script)}/deployments`);
  if ("error" in worker) return { state: "waiting", reason: `Worker deployment read unavailable: ${worker.error}` };
  const deployments = deploymentSchema.safeParse(worker.value);
  if (!deployments.success) return { state: "waiting", reason: "Worker deployment response is incomplete" };
  const current = deployments.data.deployments[0];
  const selected = current.versions.find((version) => version.version_id === intent.versionId);
  if (!selected)
    return Date.parse(current.created_on) >= intent.since
      ? { state: "failed", reason: "uploaded Worker version was superseded" }
      : { state: "waiting", reason: "uploaded Worker deployment has not registered" };
  const workerReason = `Worker version ${intent.versionId} serves ${selected.percentage}%`;
  if (selected.percentage !== 100 || !intent.container)
    return { state: selected.percentage === 100 ? "ready" : "waiting", reason: workerReason };

  const container = intent.container;
  const path = `/containers/applications/${encodeURIComponent(container.application)}/rollouts`;
  const read = await get(intent.rolloutId ? `${path}/${encodeURIComponent(intent.rolloutId)}` : path);
  if ("error" in read) return { state: "waiting", reason: `container rollout read unavailable: ${read.error}` };
  const matchesTarget = (row: z.infer<typeof rolloutSchema>) =>
    Date.parse(row.created_at) >= intent.since &&
    (container.beforeVersion === undefined ||
      (row.current_version === container.beforeVersion && row.target_version > container.beforeVersion)) &&
    (!container.image || row.target_configuration.image === container.image);
  let row: z.infer<typeof rolloutSchema>;
  if (intent.rolloutId) {
    const parsed = rolloutSchema.safeParse(read.value);
    if (!parsed.success) return { state: "failed", reason: "container rollout response is incomplete" };
    row = parsed.data;
    if (row.id !== intent.rolloutId || !matchesTarget(row))
      return { state: "failed", reason: "pinned container rollout target changed" };
  } else {
    const parsed = z.array(rolloutSchema).safeParse(read.value);
    if (!parsed.success) return { state: "waiting", reason: "container rollout list is incomplete" };
    const matches = parsed.data.filter(matchesTarget);
    if (matches.length > 1) return { state: "failed", reason: "container rollout identity is ambiguous" };
    if (matches.length === 0) return { state: "waiting", reason: "selected container rollout has not registered" };
    row = matches[0];
  }
  const progress = row.progress;
  const reason =
    `rollout ${row.id} ${row.status}: version ${row.current_version} → ${row.target_version}` +
    (progress
      ? `; step ${progress.current_step}/${progress.total_steps}; updated ${progress.updated_instances}/${progress.total_instances}`
      : "") +
    `; health errors ${row.health.errors.length}`;
  return {
    state: row.status === "completed" ? "ready" : ["replaced", "reverted"].includes(row.status) ? "failed" : "waiting",
    rolloutId: row.id,
    reason,
  };
}
