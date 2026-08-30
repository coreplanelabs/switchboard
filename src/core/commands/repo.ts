import { z } from "zod";
import { CommandError, commandDefiner, flag, type Caller, type CommandDef, type CommandRegistry, type JsonObject, type JsonValue } from "../commandRegistry.js";
import type { Operations, OpName } from "../operations.js";
import { parseSlug, repoResourceId, validRef, type ResidentAdminClient, type ResidentAdminResponse } from "../residentAdmin.js";

// The `repo.*` registrations (#157 R13 + phase 4b): the whole repo surface on
// ONE typed model.
//   repo list                                  — the live resident registry (open)
//   repo onboard <slug> [--ref] [--test] [--build] [--install] [--evict-coldest]
//   repo offboard <slug> [--dry-run]           — `repoManager` gate (KTD9 fail-closed:
//   repo reconfigure <slug> [--ref] [--test…]    admins ∪ permissions.repoManagement),
//   repo rebuild <slug> [--dry-run]              `repo:write` on machine surfaces
//   repo test <slug> [ref] / repo build <slug> [ref]
//                                              — deterministic ops (U6/KTD8): `agentRun`
//                                                gate (= canRunAgent(coding), the implicit
//                                                target agent) + the per-repo allowlist
//                                                inside; `repo:exec` on machine surfaces
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
    admin(): ResidentAdminClient | { unavailable: string };
    /** The deterministic-op backend for this caller (resident-backed when a
     *  resident is configured, local for local execution), or null when none
     *  exists (a per-thread remote backend has no op surface). */
    operations(caller: Caller): Operations | null;
    /** Per-repo access for resident environments (KD7, open-when-absent). */
    canUseRepo(callerId: string, slug: string): boolean;
  };
}

const defineCommand = commandDefiner<RepoCommandDeps>();

/** Sensible Node defaults for an onboard that names no commands (the shape U3
 *  proved on jshttp/vary — install is verbatim what U3 used; test/build are
 *  the generic equivalents of its repo-specific choices). */
export const DEFAULT_COMMANDS = {
  install: "npm install --no-audit --no-fund",
  build: "npm run build --if-present",
  test: "npm test",
} as const;
export const DEFAULT_REF = "main";

/** `owner/name` (`.git` tolerated) → lowercase slug; anything else names the expected form. */
export const repoSlug = z
  .string()
  .refine((s) => parseSlug(s) !== undefined, "expected a GitHub owner/name slug")
  .transform((s) => parseSlug(s) as string);
/** The resident's strict branch-ref pattern — a hostile ref never reaches any backend (KTD8). */
export const gitRef = z.string().refine((s) => validRef(s) !== undefined, "expected a plausible git branch ref (e.g. main)");
const command = z.string().min(1);

const slugArg = { name: "slug", schema: repoSlug, describe: "GitHub owner/name of the repo" } as const;

// ---- shared -------------------------------------------------------------------

function adminOf(deps: RepoCommandDeps): ResidentAdminClient {
  const api = deps.repo.admin();
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
  const code = r.status === 404 ? "not_found" : r.status === 409 || r.status === 429 ? "conflict" : r.status === 400 ? "invalid_input" : "unavailable";
  return new CommandError(code, [`HTTP ${r.status}: ${String(r.data.error ?? "unknown error")}`, ...extra].join("\n"));
}

const n = (v: unknown): string => String(typeof v === "number" ? v : (v ?? "?"));
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? "?"));

// ---- repo list ------------------------------------------------------------------

/** The `repo list` reply, rendered from the resident Worker's `/residents` body. */
export function renderResidentList(data: Record<string, unknown>): string {
  const residents = (data.residents as Array<Record<string, unknown>> | undefined) ?? [];
  if (residents.length === 0) return `No repos onboarded (0/${n(data.cap)}). Onboard one with \`repo onboard <owner/name>\`.`;
  const lines = residents.map((rec) => {
    const live = obj(rec.live);
    const slug = String(rec.resource ?? "").replace(/^repo:/, "");
    const state = String(live.state ?? "unknown");
    const reason = String(live.reason ?? "");
    const sha = typeof live.sha === "string" && live.sha ? ` · sha \`${live.sha.slice(0, 8)}\`` : "";
    const refreshed = typeof live.lastRefreshAt === "string" && live.lastRefreshAt ? ` · refreshed ${live.lastRefreshAt}` : "";
    return `• \`${slug}\` — *${state}*${reason ? ` (${reason})` : ""} · ref \`${String(rec.defaultRef ?? "?")}\`${sha}${refreshed}`;
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
  scope: "repo:read",
  chatGate: "open",
  effect: "read",
  describe: "Every onboarded resident repo with its live state, ref, sha, and last refresh.",
  render: (output) => renderResidentList(output as Record<string, unknown>),
  handler: async ({ deps }) => {
    const res = await call(() => adminOf(deps).residents());
    if (res.status !== 200) throw new CommandError("unavailable", `repo list failed (HTTP ${res.status}): ${String(res.data.error ?? "unknown error")}`);
    return res.data as JsonValue;
  },
});

// ---- repo onboard ----------------------------------------------------------------

export const repoOnboard = defineCommand({
  id: "repo.onboard",
  args: [slugArg],
  options: z.object({
    ref: gitRef.optional().describe(`default branch to keep warm (default ${DEFAULT_REF})`),
    test: command.optional().describe(`the repo's test command (default \`${DEFAULT_COMMANDS.test}\`)`),
    build: command.optional().describe(`the repo's build command (default \`${DEFAULT_COMMANDS.build}\`)`),
    install: command.optional().describe(`the repo's install command (default \`${DEFAULT_COMMANDS.install}\`)`),
    evictColdest: flag.optional().describe("over the resident cap, offboard the coldest eligible warm resident instead of failing (#50)"),
  }),
  scope: "repo:write",
  chatGate: "repoManager",
  effect: "write",
  describe: "Onboard a repo as an always-warm resident environment (provisions billable compute; admin-gated).",
  render: (output) => {
    const o = output as JsonObject;
    const commands = obj(o.commands);
    const lines = [
      `🏗️ Onboarding \`${str(o.slug)}\` on \`${str(o.defaultRef)}\` — provisioning started (state \`onboarding\`; watch \`repo list\` until it reaches \`warm\`).`,
      `Commands: install \`${str(commands.install)}\` · build \`${str(commands.build)}\` · test \`${str(commands.test)}\``,
    ];
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
    const commands = {
      ...DEFAULT_COMMANDS,
      ...(options.test !== undefined ? { test: options.test } : {}),
      ...(options.build !== undefined ? { build: options.build } : {}),
      ...(options.install !== undefined ? { install: options.install } : {}),
    };
    const defaultRef = options.ref ?? DEFAULT_REF;
    const r = await call(() => adminOf(deps).onboard({ resource: repoResourceId(args.slug), commands, defaultRef, ...(options.evictColdest ? { evictColdest: true } : {}) }));
    if (r.status !== 202) {
      // Over the cap with --evict-coldest and nothing eligible: the resident
      // itemizes why each one was kept (#50) — relay it so the admin can
      // offboard by hand with the facts in front of them.
      const rejected = r.status === 429 && Array.isArray(r.data.rejected) ? (r.data.rejected as Array<Record<string, unknown>>) : [];
      const reasons = rejected.filter((x) => typeof x.resource === "string" && typeof x.why === "string").map((x) => `• \`${String(x.resource).replace(/^repo:/, "")}\` — ${String(x.why)}`);
      throw residentFailure(r, reasons);
    }
    return {
      slug: args.slug,
      defaultRef,
      commands,
      state: "onboarding",
      ...(r.data.evicted !== undefined ? { evicted: r.data.evicted as JsonValue } : {}),
      ...(typeof r.data.warning === "string" ? { warning: r.data.warning } : {}),
    };
  },
});

// ---- repo offboard / rebuild -------------------------------------------------------

const dryRunOptions = z.object({
  dryRun: flag.optional().describe("compute and return the itemized plan without executing"),
});

export const repoOffboard = defineCommand({
  id: "repo.offboard",
  args: [slugArg],
  options: dryRunOptions,
  scope: "repo:write",
  chatGate: "repoManager",
  effect: "write",
  describe: "Tear down a resident repo: registry record, schedules, container, R2 snapshots (admin-gated; --dry-run plans only).",
  render: (output) => {
    const o = output as JsonObject;
    const slug = str(o.slug);
    if (o.dryRun === true) {
      const w = obj(o.wouldRemove);
      const ids = Array.isArray(w.snapshotBackupIds) && w.snapshotBackupIds.length > 0 ? ` (ids ${(w.snapshotBackupIds as string[]).join(", ")})` : "";
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
    const r = await call(() => adminOf(deps).offboard(repoResourceId(args.slug), dryRun));
    if (r.status !== 200) throw residentFailure(r);
    return { ...(r.data as JsonObject), slug: args.slug, dryRun };
  },
});

export const repoRebuild = defineCommand({
  id: "repo.rebuild",
  args: [slugArg],
  options: dryRunOptions,
  scope: "repo:write",
  chatGate: "repoManager",
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
      `(state \`onboarding\` — watch \`repo list\` until it reaches \`warm\`).`
    );
  },
  handler: async ({ args, options, deps }) => {
    const dryRun = options.dryRun ?? false;
    const r = await call(() => adminOf(deps).rebuild(repoResourceId(args.slug), dryRun));
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
  scope: "repo:write",
  chatGate: "repoManager",
  effect: "write",
  describe: "Change a resident's default branch and/or command table (admin-gated; takes effect on the next refresh/attach).",
  render: (output) => {
    const o = output as JsonObject;
    const changed = Object.entries(obj(o.changed)).map(([k, v]) => `${k} → \`${str(v)}\``);
    return `🔧 Reconfigured \`${str(o.slug)}\`: ${changed.join(", ")}. Takes effect on the next refresh/attach.`;
  },
  handler: async ({ args, options, deps }) => {
    const commands: Record<string, string> = {};
    for (const key of ["test", "build", "install"] as const) if (options[key] !== undefined) commands[key] = options[key];
    if (Object.keys(commands).length === 0 && options.ref === undefined) {
      throw new CommandError("invalid_input", "nothing to reconfigure: pass --ref and/or --test / --build / --install");
    }
    const api = adminOf(deps);
    const body: Record<string, unknown> = { resource: repoResourceId(args.slug) };
    if (Object.keys(commands).length > 0) {
      // The resident's /reconfigure REPLACES the whole command table (KTD9), so
      // a partial patch is merged onto the current table — fetched live.
      const list = await call(() => api.residents());
      if (list.status !== 200) throw residentFailure(list);
      const residents = (list.data.residents as Array<Record<string, unknown>> | undefined) ?? [];
      const record = residents.find((rec) => rec.resource === repoResourceId(args.slug));
      if (!record) throw new CommandError("not_found", `\`${args.slug}\` is not onboarded — \`repo onboard ${args.slug}\` first.`);
      body.commands = { ...obj(record.commands), ...commands };
    }
    if (options.ref !== undefined) body.defaultRef = options.ref;
    const r = await call(() => api.reconfigure(body));
    if (r.status !== 200) throw residentFailure(r);
    return { slug: args.slug, changed: { ...(options.ref !== undefined ? { ref: options.ref } : {}), ...commands } };
  },
});

// ---- repo test / repo build (deterministic ops, U6/KTD8) -----------------------------------

export const NO_OPS_BACKEND_MESSAGE = "Deterministic ops need a backend: configure `execution.resident` (with its operator token) or local execution.";

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
    args: [slugArg, { name: "ref", schema: gitRef.optional(), describe: "branch to run on (default: the resident's default ref)" }],
    scope: "repo:exec",
    chatGate: "agentRun",
    effect: "write",
    describe: `Run the repo's onboarded ${op} command with zero model turns (needs coding-agent access; the ref must be a plausible branch).`,
    render: renderOp,
    handler: async ({ args, caller, deps }) => {
      // KD7: the same per-repo allowlist a coding run against this repo passes.
      if (!deps.repo.canUseRepo(caller.id, args.slug)) throw new CommandError("unauthorized", `You're not on the allowlist for the \`${args.slug}\` repo environment.`);
      const ops = deps.repo.operations(caller);
      if (!ops) throw new CommandError("unavailable", NO_OPS_BACKEND_MESSAGE);
      const req = { repo: args.slug, ...(args.ref !== undefined ? { ref: args.ref } : {}) };
      const result = await ops.run(op, req).catch((err: unknown) => ({ kind: "error" as const, message: err instanceof Error ? err.message : String(err) }));
      switch (result.kind) {
        case "result":
          return { op, ...req, ok: result.ok, summary: result.summary, ...(result.output !== undefined ? { output: result.output } : {}) };
        case "refused":
          throw new CommandError("conflict", result.reason);
        case "not-onboarded":
          throw new CommandError("not_found", `\`${args.slug}\` is not onboarded as a resident, so \`repo ${op}\` has nothing to run against — \`repo onboard ${args.slug}\` first, or ask the coding agent directly.`);
        case "error":
          throw new CommandError("unavailable", result.message);
      }
    },
  });
}

export const repoTest = defineOp("test");
export const repoBuild = defineOp("build");

export const repoCommands: readonly CommandDef<RepoCommandDeps>[] = [repoList, repoOnboard, repoOffboard, repoReconfigure, repoRebuild, repoTest, repoBuild] as unknown as CommandDef<RepoCommandDeps>[];

export function registerRepoCommands<D extends RepoCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of repoCommands) registry.register(cmd as unknown as CommandDef<D>);
}
