import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperatorRoot } from "./operatorRoot.js";

// The work area of a package-mode deploy (docs/reference/specs/release-and-deploy.md item 24;
// packaging.md item 7). `deploy all`, `deploy secrets` and `deploy init` run
// wrangler in a Worker's directory, with that directory's `node_modules` and a
// `wrangler.jsonc` rendered beside its template. From the published package
// those directories do not exist: the shipped tree — the Worker directories,
// the sources their `worker.ts` import, the root manifest and lockfile — is
// copied out of the package's `dist/assets/` into `<root>/.switchboard/`, and
// each Worker the operator deploys is installed there with `npm ci --workspace
// deploy/<worker>` against the shipped lockfile: the exact versions the
// release was tested with, and nothing the operator's machine resolved for
// itself. A stamp file records the CLI version the copy came from and the
// Workers installed so far; a CLI at another version starts the work area
// over, and a Worker already installed is not installed again. Prebuilt
// bundles would remove the install — a later optimisation; today wrangler
// runs in the materialised directory exactly as it does in a checkout.
//
// Pure decisions here (`planWorkArea`); the copy and the stamp are this
// module's I/O; `npm ci` is injected so the tests never spawn it.

/** The stamp at the work area's root: which CLI version the copy came from and which Workers are installed. */
export const WORK_AREA_STAMP = ".materialised.json";

export interface WorkAreaStamp {
  version: string;
  /** The Worker directories (`deploy/<worker>`) `npm ci` has installed in this work area. */
  installed: string[];
}

/** What is on disk where the work area goes: nothing yet, a stamped work area, or something else. */
export type WorkAreaState = { kind: "absent" } | { kind: "stamped"; stamp: WorkAreaStamp } | { kind: "foreign" };

export type WorkAreaPlan =
  /** The directory is not a work area this CLI made: never deleted, said out loud. */
  | { kind: "refuse"; problem: string }
  | {
      kind: "proceed";
      /** Start over: remove what is there and copy the shipped tree afresh. */
      copy: boolean;
      /** The Worker directories to `npm ci` — every requested one after a copy, else only those not yet installed. */
      install: string[];
      /** The stamp to write once the work is done. */
      stamp: WorkAreaStamp;
    };

/**
 * Pure: given what is on disk, the CLI's version and the Workers about to run,
 * what to do. One `npm ci` installs the union of what was installed and what
 * is requested — `npm ci` starts from an empty `node_modules`, so installing
 * one workspace alone would drop the others'.
 */
export function planWorkArea(
  state: WorkAreaState,
  version: string,
  workers: readonly string[],
  at: string,
): WorkAreaPlan {
  if (state.kind === "foreign")
    return {
      kind: "refuse",
      problem: `${at} exists but is not a work area this CLI made (no ${WORK_AREA_STAMP}) — move it aside; the deploy commands own that directory`,
    };
  const copy = state.kind === "absent" || state.stamp.version !== version;
  const already = copy ? [] : state.stamp.installed;
  const missing = workers.filter((w) => !already.includes(w));
  const installed = missing.length > 0 ? [...new Set([...already, ...workers])].sort() : already;
  return {
    kind: "proceed",
    copy,
    install: missing.length > 0 ? installed : [],
    stamp: { version, installed },
  };
}

/** Pure: a stamp file's text, or undefined when it is not one. */
export function parseWorkAreaStamp(text: string | undefined): WorkAreaStamp | undefined {
  if (text === undefined) return undefined;
  try {
    const raw = JSON.parse(text) as { version?: unknown; installed?: unknown };
    if (typeof raw.version !== "string" || !Array.isArray(raw.installed)) return undefined;
    if (!raw.installed.every((w) => typeof w === "string")) return undefined;
    return { version: raw.version, installed: raw.installed as string[] };
  } catch {
    return undefined;
  }
}

/** What is at the work area's path. An empty directory counts as absent. */
export function readWorkAreaState(workArea: string): WorkAreaState {
  if (!existsSync(workArea)) return { kind: "absent" };
  const stampPath = join(workArea, WORK_AREA_STAMP);
  if (existsSync(stampPath)) {
    const stamp = parseWorkAreaStamp(readFileSync(stampPath, "utf8"));
    return stamp ? { kind: "stamped", stamp } : { kind: "foreign" };
  }
  return readdirSync(workArea).length === 0 ? { kind: "absent" } : { kind: "foreign" };
}

export interface WorkAreaDeps {
  /** `npm ci --workspace <w>…` in `cwd`; the exit code and the combined output. */
  install(cwd: string, workspaces: readonly string[]): Promise<{ code: number; output: string }>;
  log(line: string): void;
}

export type WorkAreaOutcome = { ok: true; copied: boolean; installed: string[] } | { ok: false; problem: string };

/**
 * Make the work area ready for `workers`: the shipped tree copied (afresh when
 * the CLI's version changed), each requested Worker installed once. `workers`
 * empty means the copy alone — what `deploy init` needs to render a config.
 * Never touches a directory it did not stamp.
 */
export async function ensureWorkArea(
  at: Pick<OperatorRoot, "assets" | "workArea">,
  version: string,
  workers: readonly string[],
  deps: WorkAreaDeps,
): Promise<WorkAreaOutcome> {
  const plan = planWorkArea(readWorkAreaState(at.workArea), version, workers, at.workArea);
  if (plan.kind === "refuse") return { ok: false, problem: plan.problem };
  if (plan.copy) {
    rmSync(at.workArea, { recursive: true, force: true });
    mkdirSync(at.workArea, { recursive: true });
    cpSync(at.assets, at.workArea, { recursive: true });
    // Stamped before the install: a failed `npm ci` leaves a work area, not a foreign directory.
    writeStamp(at.workArea, { version, installed: [] });
    deps.log(`[deploy] materialised the shipped tree (version ${version}) under ${at.workArea}`);
  }
  if (plan.install.length > 0) {
    deps.log(`[deploy] npm ci --workspace ${plan.install.join(" --workspace ")} under ${at.workArea}`);
    const r = await deps.install(at.workArea, plan.install);
    if (r.code !== 0)
      return {
        ok: false,
        problem: `npm ci for ${plan.install.join(", ")} under ${at.workArea} exited ${r.code}: ${r.output.trim().split("\n").slice(-3).join(" | ")}`,
      };
    writeStamp(at.workArea, plan.stamp);
  }
  return { ok: true, copied: plan.copy, installed: plan.install };
}

/**
 * Pure: the `image` a rendered `wrangler.jsonc` builds from when it is a
 * Dockerfile OUTSIDE the Worker's own directory (`../…`), else undefined — a
 * registry reference or a Dockerfile beside the config is buildable from a
 * materialised directory; the bot's `../../Dockerfile` needs the repository
 * around it, which the package does not carry. Comment lines are ignored.
 */
export function imageBuiltOutsideDir(renderedConfig: string): string | undefined {
  const code = renderedConfig
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  for (const m of code.matchAll(/"image"\s*:\s*"([^"]+)"/g)) {
    if (m[1].startsWith("../")) return m[1];
  }
  return undefined;
}

function writeStamp(workArea: string, stamp: WorkAreaStamp): void {
  writeFileSync(join(workArea, WORK_AREA_STAMP), `${JSON.stringify(stamp, null, 2)}\n`);
}
