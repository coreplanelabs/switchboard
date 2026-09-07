import { z } from "zod";
import {
  CommandError,
  commandDefiner,
  flag,
  type Caller,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";
import type { Operations, OpName } from "../operations.js";
import {
  parseSlug,
  repoResourceId,
  validRef,
  type ResidentAdminClient,
  type ResidentAdminResponse,
} from "../residentAdmin.js";
import { NO_OP_COMMAND, NPM_FALLBACK_COMMANDS, detectCommands, type DetectedCommands } from "../repoToolchain.js";
import { formatDiskGauge } from "../../execution/residentDiskBudget.js";
import type { RepoInspector } from "../../execution/githubRepoInspect.js";

// The `repo.*` registrations (#157 R13 + phase 4b): the whole repo surface on
// ONE typed model.
//   repo list                                  — the live resident registry (`repo:read`,
//                                                what every Slack user holds)
//   repo onboard <slug> [--ref] [--test] [--build] [--install] [--evict-coldest]
//   repo offboard <slug> [--dry-run]           — `repo:write`: the repo-management right
//   repo reconfigure <slug> [--ref] [--test…]    (KTD9 fail-closed: admins ∪
//   repo rebuild <slug> [--dry-run]              permissions.repoManagement, or a token
//                                                minted with it)
//   repo test <slug> [ref] / repo build <slug> [ref]
//                                              — deterministic ops (U6/KTD8): `repo:exec`
//                                                decided on `agent { coding }` (the implicit
//                                                target agent — the right to run it, or the
//                                                exec grant) + the per-repo allowlist inside
// Every gate is a policy row (features/authorization.md); the handlers hold no
// identity comparison of their own.
// The handlers are thin: typed args/options → the resident Worker's admin
// routes, or the `Operations` backend (resident `/op` or local). Nothing here
// starts an agent run (KTD16): a deterministic op runs the repo's ONBOARDED
// command with zero model turns; the natural-language forms the dispatcher
// recognizes are translated into these same two commands.
//
// Destructive verbs (`offboard`, `rebuild`) take `--dry-run`: the resident
// computes and returns the itemized plan (the same shape its real teardown/
// rebuild reports) WITHOUT executing — the stateful-op checkpoint.

/** Resolves per call (config can reload); `unavailable` carries the
 *  operator-facing reason when the resident is not configured. */
export interface RepoCommandDeps {
  repo: {
    admin(): Promise<ResidentAdminClient | { unavailable: string }>;
    /** The deterministic-op backend for this caller (resident-backed when a
     *  resident is configured, local for local execution), or null when none
     *  exists (a per-thread remote backend has no op surface). */
    operations(caller: Caller): Promise<Operations | null>;
    /** Per-repo access for resident environments (KD7, open-when-absent). */
    canUseRepo(callerId: string, slug: string): Promise<boolean>;
    /** Reads the repo root before `onboard` chooses a command table (item 52).
     *  Absent, or a named failure → the npm fallback table WITH a warning in
     *  the reply; the table is never silently assumed. */
    inspect?: RepoInspector;
    /** The provisioning follow-up's clock (tests inject a no-op). */
    sleep?: (ms: number) => Promise<void>;
  };
}

const defineCommand = commandDefiner<RepoCommandDeps>();

/** The table an uninspectable onboard falls back to (the shape U3 proved on
 *  jshttp/vary). An INSPECTED onboard derives its table from the repo root
 *  instead (`detectCommands`, item 52). */
export const DEFAULT_COMMANDS = NPM_FALLBACK_COMMANDS;
export const DEFAULT_REF = "main";

/** The provisioning follow-up (`settle`, item 52): poll the resident's `/status`
 *  this often, and give up (still reporting) after this long — a step budget
 *  is 5 min and provisioning is two steps plus clone + snapshot. */
export const SETTLE_POLL_MS = 10_000;
export const SETTLE_MAX_MS = 12 * 60_000;

/** `owner/name` (`.git` tolerated) → lowercase slug; anything else names the expected form. */
export const repoSlug = z
  .string()
  .refine((s) => parseSlug(s) !== undefined, "expected a GitHub owner/name slug")
  .transform((s) => parseSlug(s) as string);
/** The resident's strict branch-ref pattern — a hostile ref never reaches any backend (KTD8). */
export const gitRef = z
  .string()
  .refine((s) => validRef(s) !== undefined, "expected a plausible git branch ref (e.g. main)");
const command = z.string().min(1);

const slugArg = { name: "slug", schema: repoSlug, describe: "GitHub owner/name of the repo" } as const;

// ---- shared -------------------------------------------------------------------

async function adminOf(deps: RepoCommandDeps): Promise<ResidentAdminClient> {
  const api = await deps.repo.admin();
  if ("unavailable" in api) throw new CommandError("unavailable", api.unavailable);
  return api;
}

/** A transport failure of the admin client is the resident being unreachable. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new CommandError("unavailable", err instanceof Error ? err.message : String(err));
  }
}

/** A non-success from the resident, as a registry error: 404 → `not_found`,
 *  409/429 → `conflict`, 400 → `invalid_input`, anything else → `unavailable`;
 *  the message carries the status and the resident's own `error` text. */
function residentFailure(r: ResidentAdminResponse, extra: string[] = []): CommandError {
  const code =
    r.status === 404
      ? "not_found"
      : r.status === 409 || r.status === 429
        ? "conflict"
        : r.status === 400
          ? "invalid_input"
          : "unavailable";
  return new CommandError(code, [`HTTP ${r.status}: ${String(r.data.error ?? "unknown error")}`, ...extra].join("\n"));
}

const n = (v: unknown): string => String(typeof v === "number" ? v : (v ?? "?"));
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? "?"));

// ---- repo list ------------------------------------------------------------------

/** The `repo list` reply, rendered from the resident Worker's `/residents` body. */
export function renderResidentList(data: Record<string, unknown>): string {
  const residents = (data.residents as Array<Record<string, unknown>> | undefined) ?? [];
  if (residents.length === 0)
    return `No repos onboarded (0/${n(data.cap)}). Onboard one with \`repo onboard <owner/name>\`.`;
  const lines = residents.map((rec) => {
    const live = obj(rec.live);
    const slug = String(rec.resource ?? "").replace(/^repo:/, "");
    const state = String(live.state ?? "unknown");
    const reason = String(live.reason ?? "");
    const sha = typeof live.sha === "string" && live.sha ? ` · sha \`${live.sha.slice(0, 8)}\`` : "";
    const refreshed =
      typeof live.lastRefreshAt === "string" && live.lastRefreshAt ? ` · refreshed ${live.lastRefreshAt}` : "";
    // Item 55: the disk gauge from the resident's last sample (`live.disk`),
    // the same used/total (pct) reading as /residents and the watchdog line.
    const d = obj(live.disk);
    const disk =
      typeof d.usedKiB === "number" && typeof d.totalKiB === "number"
        ? ` · disk ${formatDiskGauge({ usedKiB: d.usedKiB, totalKiB: d.totalKiB })}`
        : "";
    return `• \`${slug}\` — *${state}*${reason ? ` (${reason})` : ""} · ref \`${String(rec.defaultRef ?? "?")}\`${sha}${refreshed}${disk}`;
  });
  const out = [`*Resident repos* (${n(data.count)}/${n(data.cap)}):`, ...lines];
  // Item 49: a test override lowers the enforced cap/floor for live checks —
  // say so, or the count above reads as the real cap.
  const t = data.testOverrides as Record<string, unknown> | undefined;
  if (t && typeof t === "object") {
    out.push(
      `⚠️ test overrides active (set ${String(t.setAt ?? "?")}): cap ${n(data.cap)} (default ${n(data.capDefault)}), ` +
        `LRU floor ${n(t.floorS)}s (default ${n(t.floorDefaultS)}s) — clear with \`POST /debug {"op":"set-test-overrides"}\`.`,
    );
  }
  return out.join("\n");
}

export const repoList = defineCommand({
  id: "repo.list",
  action: "repo:read",
  effect: "read",
  describe: "Every onboarded resident repo with its live state, ref, sha, last refresh, and disk gauge.",
  render: (output) => renderResidentList(output as Record<string, unknown>),
  handler: async ({ deps }) => {
    const res = await call(async () => (await adminOf(deps)).residents());
    if (res.status !== 200)
      throw new CommandError(
        "unavailable",
        `repo list failed (HTTP ${res.status}): ${String(res.data.error ?? "unknown error")}`,
      );
    return res.data as JsonValue;
  },
});

// ---- repo onboard ----------------------------------------------------------------

export const repoOnboard = defineCommand({
  id: "repo.onboard",
  args: [slugArg],
  options: z.object({
    ref: gitRef.optional().describe(`default branch to keep warm (default ${DEFAULT_REF})`),
    test: command
      .optional()
      .describe(
        "the repo's test command (default: detected from the repo root — `<pm> test`, or a no-op without a test script)",
      ),
    build: command
      .optional()
      .describe("the repo's build command (default: detected — `<pm> run build`, or a no-op without a build script)"),
    install: command
      .optional()
      .describe(
        "the repo's install command (default: detected from the root lockfile / packageManager — pnpm, yarn, bun, or npm; none without a package.json)",
      ),
    evictColdest: flag
      .optional()
      .describe("over the resident cap, offboard the coldest eligible warm resident instead of failing (#50)"),
  }),
  action: "repo:write",
  effect: "write",
  describe: "Onboard a repo as an always-warm resident environment (provisions billable compute; admin-gated).",
  render: (output) => {
    const o = output as JsonObject;
    const commands = obj(o.commands);
    const lines = [
      `🏗️ Onboarding \`${str(o.slug)}\` on \`${str(o.defaultRef)}\` — provisioning started (state \`onboarding\`). I'll report here when it is warm or has failed; \`repo list\` shows the live state meanwhile.`,
    ];
    const detection = obj(o.detection);
    const explicit = new Set(Array.isArray(o.explicit) ? o.explicit.map(String) : []);
    if (typeof detection.unavailable === "string") {
      const defaulted = COMMAND_KEYS.filter((k) => !explicit.has(k));
      lines.push(
        defaulted.length === 0
          ? `⚠️ Repo root not inspected (${detection.unavailable}) — every command was given explicitly, so nothing was assumed.`
          : `⚠️ Repo root not inspected (${detection.unavailable}) — using npm defaults${defaulted.length < COMMAND_KEYS.length ? ` for ${listWords(defaulted)}` : ""}. If the repo is not an npm package, \`repo reconfigure\` the commands before it fails.`,
      );
    } else {
      const notes = Array.isArray(detection.notes) ? detection.notes.map(String) : [];
      lines.push(`Toolchain: ${str(o.toolchain)}${notes.length ? ` (${notes.join("; ")})` : ""}`);
    }
    lines.push(`Commands: ${COMMAND_KEYS.map((k) => commandCell(k, commands[k], explicit.has(k))).join(" · ")}`);
    const evicted = obj(o.evicted);
    if (typeof evicted.resource === "string") {
      const errors = Array.isArray(evicted.errors) ? evicted.errors.length : 0;
      lines.push(
        `♻️ Made room: evicted \`${evicted.resource.replace(/^repo:/, "")}\` (coldest warm resident, last used ${String(evicted.lastActivityAt ?? "unknown")}; ` +
          `${n(evicted.backupObjectsDeleted)} backup objects deleted${errors ? `, ${errors} teardown error(s)` : ""}).`,
      );
    }
    if (typeof o.warning === "string" && o.warning) lines.push(`⚠️ ${o.warning}`);
    return lines.join("\n");
  },
  handler: async ({ args, options, deps }) => {
    const defaultRef = options.ref ?? DEFAULT_REF;
    // Item 52: the table comes from the repo root, not from an assumption. An
    // explicit flag wins per key; an uninspectable root falls back to the npm
    // table and the reply SAYS so.
    let detected: DetectedCommands | undefined;
    let unavailable: string | undefined;
    if (!deps.repo.inspect) unavailable = "no repo inspector configured";
    else {
      const r = await deps.repo.inspect(args.slug, defaultRef);
      if (r.ok) detected = detectCommands(r.facts);
      else unavailable = r.reason;
    }
    const explicit = COMMAND_KEYS.filter((k) => options[k] !== undefined);
    const commands: { install?: string; build: string; test: string } = {
      ...(detected ? detected.commands : DEFAULT_COMMANDS),
      ...(options.test !== undefined ? { test: options.test } : {}),
      ...(options.build !== undefined ? { build: options.build } : {}),
      ...(options.install !== undefined ? { install: options.install } : {}),
    };
    const r = await call(async () =>
      (await adminOf(deps)).onboard({
        resource: repoResourceId(args.slug),
        commands,
        defaultRef,
        ...(options.evictColdest ? { evictColdest: true } : {}),
      }),
    );
    if (r.status !== 202) {
      // Over the cap with --evict-coldest and nothing eligible: the resident
      // itemizes why each one was kept (#50) — relay it so the admin can
      // offboard by hand with the facts in front of them.
      const rejected =
        r.status === 429 && Array.isArray(r.data.rejected) ? (r.data.rejected as Array<Record<string, unknown>>) : [];
      const reasons = rejected
        .filter((x) => typeof x.resource === "string" && typeof x.why === "string")
        .map((x) => `• \`${String(x.resource).replace(/^repo:/, "")}\` — ${String(x.why)}`);
      throw residentFailure(r, reasons);
    }
    return {
      slug: args.slug,
      defaultRef,
      commands,
      toolchain: detected?.toolchain ?? null,
      detection: detected ? { notes: detected.notes } : { unavailable: unavailable ?? "unknown" },
      explicit,
      state: "onboarding",
      ...(r.data.evicted !== undefined ? { evicted: r.data.evicted as JsonValue } : {}),
      ...(typeof r.data.warning === "string" ? { warning: r.data.warning } : {}),
    };
  },
  settle: (output, { deps }) => settleProvisioning(deps, str((output as JsonObject).slug)),
});

/** The command table's keys, in reply order. */
const COMMAND_KEYS = ["install", "build", "test"] as const;

/** `install \`cmd\``, or the honest reading of a DETECTED no-op: `build — none
 *  (\`true\`)`. A command the operator typed is always shown verbatim — an
 *  explicit `--build true` is their choice, not detection's. */
function commandCell(name: string, value: unknown, explicit: boolean): string {
  if (value === undefined || value === null) return `${name} — none`;
  if (value === NO_OP_COMMAND && !explicit) return `${name} — none (\`${NO_OP_COMMAND}\`)`;
  return `${name} \`${str(value)}\``;
}

/** `a`, `a and b`, `a, b, and c`. */
function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}

/**
 * The provisioning follow-up (item 52): after an onboard or rebuild is accepted
 * (202, state `onboarding`), poll `/status` until the resident leaves
 * `onboarding` and say what happened — `warm`, or `down` with the resident's
 * own reason plus the hint that fits it: the two commands that fix a bad
 * table when the failure was at install/build/test (a step the table
 * controls), a plain retry otherwise (clone, snapshot, timeout — the
 * resident's or Cloudflare's side; live 2026-09-04 a snapshot `put` 10043
 * got the table hint and misled). Bounded by
 * `SETTLE_MAX_MS`; a resident still onboarding then is reported as such (not
 * silently dropped), and every transport/404 outcome is a sentence too.
 */
export async function settleProvisioning(deps: RepoCommandDeps, slug: string): Promise<{ ok: boolean; text: string }> {
  const sleep = deps.repo.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const resource = repoResourceId(slug);
  const hint = (reason: string): string =>
    /provision-failed at (install|build|test)\b/.test(reason)
      ? `Fix the command table with \`repo reconfigure ${slug} --install "…" --build "…" --test "…"\`, then \`repo rebuild ${slug}\`.`
      : `Not a command-table failure — retry with \`repo rebuild ${slug}\`; if it recurs, the resident or Cloudflare side is at fault (\`repo list\` shows the live state).`;
  for (let elapsed = 0; elapsed <= SETTLE_MAX_MS; elapsed += SETTLE_POLL_MS) {
    if (elapsed > 0) await sleep(SETTLE_POLL_MS);
    const api = await deps.repo.admin();
    if ("unavailable" in api)
      return { ok: false, text: `⚠️ Cannot follow \`${slug}\`'s provisioning: ${api.unavailable}` };
    let r: ResidentAdminResponse;
    try {
      r = await api.status(resource);
    } catch (err) {
      return {
        ok: false,
        text: `⚠️ Lost track of \`${slug}\`'s provisioning (${err instanceof Error ? err.message : String(err)}) — check \`repo list\`.`,
      };
    }
    if (r.status === 404)
      return { ok: false, text: `⚠️ \`${slug}\` is no longer onboarded — it was offboarded while provisioning.` };
    if (r.status !== 200)
      return {
        ok: false,
        text: `⚠️ Lost track of \`${slug}\`'s provisioning (HTTP ${r.status}: ${str(r.data.error ?? "unknown error")}) — check \`repo list\`.`,
      };
    const state = str(r.data.state);
    if (state === "onboarding") continue;
    if (state === "warm") return { ok: true, text: `✅ \`${slug}\` is warm — provisioned and attach-ready.` };
    if (state === "down") {
      const reason = str(r.data.reason ?? "no reason recorded");
      return { ok: false, text: `❌ \`${slug}\` failed to provision: ${reason}\n${hint(reason)}` };
    }
    return {
      ok: true,
      text: `ℹ️ \`${slug}\` left \`onboarding\` and is \`${state}\`${r.data.reason ? ` (${str(r.data.reason)})` : ""}.`,
    };
  }
  return {
    ok: false,
    text: `⏳ \`${slug}\` is still onboarding after ${Math.round(SETTLE_MAX_MS / 60_000)} min — provisioning is slow or stuck; \`repo list\` shows the live state, and the resident watchdog marks a stuck onboard \`down\` at its deadline.`,
  };
}

// ---- repo offboard / rebuild -------------------------------------------------------

const dryRunOptions = z.object({
  dryRun: flag.optional().describe("compute and return the itemized plan without executing"),
});

export const repoOffboard = defineCommand({
  id: "repo.offboard",
  args: [slugArg],
  options: dryRunOptions,
  action: "repo:write",
  effect: "write",
  describe:
    "Tear down a resident repo: registry record, schedules, container, R2 snapshots (admin-gated; --dry-run plans only).",
  render: (output) => {
    const o = output as JsonObject;
    const slug = str(o.slug);
    if (o.dryRun === true) {
      const w = obj(o.wouldRemove);
      const ids =
        Array.isArray(w.snapshotBackupIds) && w.snapshotBackupIds.length > 0
          ? ` (ids ${(w.snapshotBackupIds as string[]).join(", ")})`
          : "";
      return [
        `🧪 *Dry run* — offboarding \`${slug}\` would remove:`,
        `• the registry record + ${n(w.schedules)} pending schedule(s)`,
        `• ${n(w.backupObjects)} snapshot backup object(s) in R2${ids}`,
        `• ${n(w.r2Objects)} object(s) under the resident's R2 prefix`,
        `• ${n(w.threadBindings)} thread binding(s) and the container (currently \`${String(w.container ?? "?")}\`)`,
        `Nothing was changed. Run \`repo offboard ${slug}\` to execute.`,
      ].join("\n");
    }
    const errors = Array.isArray(o.errors) ? (o.errors as string[]) : [];
    return (
      `🗑️ Offboarded \`${slug}\`: registry removed ${String(o.registryRemoved)}, ` +
      `schedules cancelled ${String(o.schedulesCancelled)}, container stopped ${String(o.containerStopped)}, ` +
      `storage cleared ${String(o.storageCleared)}, ${n(o.backupObjectsDeleted)} backup object(s) + ` +
      `${n(o.r2ObjectsDeleted)} prefix object(s) deleted from R2` +
      (errors.length > 0 ? `.\n⚠️ Errors: ${errors.join("; ")}` : ".")
    );
  },
  handler: async ({ args, options, deps }) => {
    const dryRun = options.dryRun ?? false;
    const r = await call(async () => (await adminOf(deps)).offboard(repoResourceId(args.slug), dryRun));
    if (r.status !== 200) throw residentFailure(r);
    return { ...(r.data as JsonObject), slug: args.slug, dryRun };
  },
});

export const repoRebuild = defineCommand({
  id: "repo.rebuild",
  args: [slugArg],
  options: dryRunOptions,
  action: "repo:write",
  effect: "write",
  describe: "Discard a resident's snapshot and reprovision it from scratch (admin-gated; --dry-run plans only).",
  render: (output) => {
    const o = output as JsonObject;
    const slug = str(o.slug);
    const discards = obj(o.discards);
    const snap = discards.snapshot ? obj(discards.snapshot) : undefined;
    const reprov = obj(o.reprovision);
    const keeps = obj(o.keeps);
    const from = obj(o.from);
    if (o.dryRun === true) {
      return [
        `🧪 *Dry run* — rebuilding \`${slug}\` (currently \`${String(from.state ?? "?")}\`${from.reason ? `: ${String(from.reason)}` : ""}) would:`,
        snap
          ? `• discard the snapshot from ${String(snap.createdAt ?? "?")} (${n(discards.backupObjects)} backup object(s); ids ${String(snap.mirrorBackupId ?? "?")}, ${String(snap.checkoutBackupId ?? "?")})`
          : "• discard no snapshot (none recorded)",
        `• reprovision from scratch on \`${String(reprov.defaultRef ?? "?")}\` (budget ${n(reprov.provisioningTimeoutMs)}ms)`,
        `• keep the registry record and ${n(keeps.threadBindings)} thread binding(s)`,
        `Nothing was changed. Run \`repo rebuild ${slug}\` to execute.`,
      ].join("\n");
    }
    return (
      `🔄 Rebuilding \`${slug}\`: discarded ${n(o.backupObjectsDeleted)} backup object(s); ` +
      `reprovisioning from scratch on \`${String(reprov.defaultRef ?? "?")}\` ` +
      `(state \`onboarding\` — I'll report here when it is warm or has failed; \`repo list\` shows the live state meanwhile).`
    );
  },
  // A dry run changed nothing, so there is nothing to follow.
  settle: (output, { deps }) => {
    const o = output as JsonObject;
    return o.dryRun === true ? Promise.resolve(undefined) : settleProvisioning(deps, str(o.slug));
  },
  handler: async ({ args, options, deps }) => {
    const dryRun = options.dryRun ?? false;
    const r = await call(async () => (await adminOf(deps)).rebuild(repoResourceId(args.slug), dryRun));
    if (r.status !== 200 && r.status !== 202) throw residentFailure(r);
    return { ...(r.data as JsonObject), slug: args.slug, dryRun };
  },
});

// ---- repo reconfigure ---------------------------------------------------------------

export const repoReconfigure = defineCommand({
  id: "repo.reconfigure",
  args: [slugArg],
  options: z.object({
    ref: gitRef.optional().describe("new default branch"),
    test: command.optional().describe("new test command"),
    build: command.optional().describe("new build command"),
    install: command.optional().describe("new install command"),
  }),
  action: "repo:write",
  effect: "write",
  describe:
    "Change a resident's default branch and/or command table (admin-gated; takes effect on the next refresh/attach).",
  render: (output) => {
    const o = output as JsonObject;
    const changed = Object.entries(obj(o.changed)).map(([k, v]) => `${k} → \`${str(v)}\``);
    return `🔧 Reconfigured \`${str(o.slug)}\`: ${changed.join(", ")}. Takes effect on the next refresh/attach.`;
  },
  handler: async ({ args, options, deps }) => {
    const commands: Record<string, string> = {};
    for (const key of ["test", "build", "install"] as const)
      if (options[key] !== undefined) commands[key] = options[key];
    if (Object.keys(commands).length === 0 && options.ref === undefined) {
      throw new CommandError("invalid_input", "nothing to reconfigure: pass --ref and/or --test / --build / --install");
    }
    const api = await adminOf(deps);
    const body: Record<string, unknown> = { resource: repoResourceId(args.slug) };
    if (Object.keys(commands).length > 0) {
      // The resident's /reconfigure REPLACES the whole command table (KTD9), so
      // a partial patch is merged onto the current table — fetched live.
      const list = await call(() => api.residents());
      if (list.status !== 200) throw residentFailure(list);
      const residents = (list.data.residents as Array<Record<string, unknown>> | undefined) ?? [];
      const record = residents.find((rec) => rec.resource === repoResourceId(args.slug));
      if (!record)
        throw new CommandError("not_found", `\`${args.slug}\` is not onboarded — \`repo onboard ${args.slug}\` first.`);
      body.commands = { ...obj(record.commands), ...commands };
    }
    if (options.ref !== undefined) body.defaultRef = options.ref;
    const r = await call(() => api.reconfigure(body));
    if (r.status !== 200) throw residentFailure(r);
    return { slug: args.slug, changed: { ...(options.ref !== undefined ? { ref: options.ref } : {}), ...commands } };
  },
});

// ---- repo test / repo build (deterministic ops, U6/KTD8) -----------------------------------

export const NO_OPS_BACKEND_MESSAGE =
  "Deterministic ops need a backend: configure `execution.resident` (with its operator token) or local execution.";

/** Failures usually speak from the END of the output — keep the tail. */
function clipOpOutput(output: string): string {
  const MAX = 3000;
  return output.length > MAX ? `…${output.slice(-MAX)}` : output;
}

function renderOp(output: JsonValue): string {
  const o = output as JsonObject;
  const icon = o.ok === true ? "✅" : "❌";
  const text = typeof o.output === "string" ? o.output.trim() : "";
  return text ? `${icon} ${str(o.summary)}\n\`\`\`\n${clipOpOutput(text)}\n\`\`\`` : `${icon} ${str(o.summary)}`;
}

function defineOp(op: Extract<OpName, "test" | "build">) {
  return defineCommand({
    id: `repo.${op}`,
    args: [
      slugArg,
      { name: "ref", schema: gitRef.optional(), describe: "branch to run on (default: the resident's default ref)" },
    ],
    action: "repo:exec",
    // The op runs as the coding agent (the implicit target of a deterministic
    // op), so the table decides on `agent { coding }`: the right to run that
    // agent, or the exec grant a token was minted with (policy.ts).
    resource: () => ({ type: "agent", name: "coding" }),
    effect: "write",
    describe: `Run the repo's onboarded ${op} command with zero model turns (needs coding-agent access; the ref must be a plausible branch).`,
    render: renderOp,
    handler: async ({ args, caller, deps }) => {
      // KD7: the same per-repo allowlist a coding run against this repo passes.
      if (!(await deps.repo.canUseRepo(caller.id, args.slug)))
        throw new CommandError(
          "unauthorized",
          `You're not on the allowlist for the \`${args.slug}\` repo environment.`,
        );
      const ops = await deps.repo.operations(caller);
      if (!ops) throw new CommandError("unavailable", NO_OPS_BACKEND_MESSAGE);
      const req = { repo: args.slug, ...(args.ref !== undefined ? { ref: args.ref } : {}) };
      const result = await ops
        .run(op, req)
        .catch((err: unknown) => ({
          kind: "error" as const,
          message: err instanceof Error ? err.message : String(err),
        }));
      switch (result.kind) {
        case "result":
          return {
            op,
            ...req,
            ok: result.ok,
            summary: result.summary,
            ...(result.output !== undefined ? { output: result.output } : {}),
          };
        case "refused":
          throw new CommandError("conflict", result.reason);
        case "not-onboarded":
          throw new CommandError(
            "not_found",
            `\`${args.slug}\` is not onboarded as a resident, so \`repo ${op}\` has nothing to run against — \`repo onboard ${args.slug}\` first, or ask the coding agent directly.`,
          );
        case "error":
          throw new CommandError("unavailable", result.message);
      }
    },
  });
}

export const repoTest = defineOp("test");
export const repoBuild = defineOp("build");

export const repoCommands: readonly CommandDef<RepoCommandDeps>[] = [
  repoList,
  repoOnboard,
  repoOffboard,
  repoReconfigure,
  repoRebuild,
  repoTest,
  repoBuild,
] as unknown as CommandDef<RepoCommandDeps>[];

export function registerRepoCommands<D extends RepoCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of repoCommands) registry.register(cmd as unknown as CommandDef<D>);
}
