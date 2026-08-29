import type { ConfigStore } from "../config.js";
import type { IncomingMessage } from "./types.js";

// Repo-management chat commands (U8): `repo onboard/offboard/reconfigure/
// rebuild/list` in the config-command family — answered inline, never sent to
// a model. All but `list` are gated by canManageRepos (KTD9: FAIL-CLOSED —
// admins only when no repo-management permission is configured, because these
// commands provision/destroy billable always-on compute and bind GitHub
// credentials). The commands talk to the resident Worker's admin routes with
// the RESIDENT_ADMIN_TOKEN bearer; the registry (command table included) is
// writable ONLY through those admin routes, and the bot never caches
// membership — `repo list` reads the live registry every time.
//
// Destructive commands (`offboard`, `rebuild`) accept `--dry-run`: the
// resident computes and returns the itemized plan (the same shape its real
// teardown/rebuild reports) WITHOUT executing — the stateful-op checkpoint.

export interface ResidentAdminResponse {
  status: number;
  data: Record<string, unknown>;
}

/** Admin-scope client for the resident Worker (deploy/cloudflare-resident/).
 *  Injectable via CoreDeps.residentAdmin for tests; the default is fetch with
 *  the RESIDENT_ADMIN_TOKEN bearer. */
export interface ResidentAdminClient {
  onboard(body: Record<string, unknown>): Promise<ResidentAdminResponse>;
  offboard(resource: string, dryRun: boolean): Promise<ResidentAdminResponse>;
  reconfigure(body: Record<string, unknown>): Promise<ResidentAdminResponse>;
  rebuild(resource: string, dryRun: boolean): Promise<ResidentAdminResponse>;
  residents(): Promise<ResidentAdminResponse>;
}

export function makeResidentAdminClient(baseUrl: string, token: string): ResidentAdminClient {
  const call = async (
    route: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
  ): Promise<ResidentAdminResponse> => {
    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/$/, "")}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new Error(
        `resident admin ${route} request failed (${err instanceof Error ? err.message : String(err)}). ` +
          "The operation may still have run in the resident; check `repo list` before re-running it.",
      );
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, data };
  };
  return {
    onboard: (body) => call("/onboard", "POST", body),
    offboard: (resource, dryRun) => call("/offboard", "POST", { resource, ...(dryRun ? { dryRun: true } : {}) }),
    reconfigure: (body) => call("/reconfigure", "POST", body),
    rebuild: (resource, dryRun) => call("/rebuild", "POST", { resource, ...(dryRun ? { dryRun: true } : {}) }),
    residents: () => call("/residents", "GET"),
  };
}

// ---- parsing ----------------------------------------------------------------

/** Sensible Node defaults for an onboard that names no commands (the shape U3
 *  proved on jshttp/vary — install is verbatim what U3 used; test/build are
 *  the generic equivalents of its repo-specific choices). */
const DEFAULT_COMMANDS = {
  install: "npm install --no-audit --no-fund",
  build: "npm run build --if-present",
  test: "npm test",
} as const;
const DEFAULT_REF = "main";

const COMMAND_KEYS = ["test", "build", "install"] as const;
type CommandKey = (typeof COMMAND_KEYS)[number];

// Mirrors the resident's REPO_ID_RE (case-tolerant here; the slug is
// lowercased before it becomes a resource id).
const SLUG_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
// Mirrors the resident's strict branch-ref pattern (U4).
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** "owner/name" (optionally ".git") → lowercase slug, or undefined. Exported
 *  for the U6 op recognizer (src/core/operations.ts), which validates the
 *  same shapes. */
export function parseSlug(token: string): string | undefined {
  const cleaned = token.replace(/\.git$/i, "");
  return SLUG_RE.test(cleaned) ? cleaned.toLowerCase() : undefined;
}

/** Validated ref or undefined — the resident's strict pattern. Exported for
 *  the U6 op recognizer: a ref that fails this NEVER reaches any backend. */
export function validRef(candidate: string): string | undefined {
  if (!REF_RE.test(candidate)) return undefined;
  if (candidate.includes("..") || candidate.includes("@{") || candidate.endsWith(".lock")) return undefined;
  return candidate;
}

/** The resident service's resource id for a repo slug (KTD1: "<type>:<id>"). */
export function repoResourceId(slug: string): string {
  return `repo:${slug}`;
}

type RepoVerb = "list" | "onboard" | "offboard" | "reconfigure" | "rebuild" | "test" | "build";

export type RepoCommand =
  | { verb: "list" }
  /** `evictColdest` (#50): `--evict-coldest` — over the cap, offboard the coldest eligible warm resident instead of failing. */
  | { verb: "onboard"; slug: string; commands: Record<CommandKey, string>; defaultRef: string; evictColdest: boolean }
  | { verb: "offboard" | "rebuild"; slug: string; dryRun: boolean }
  | { verb: "reconfigure"; slug: string; commands?: Partial<Record<CommandKey, string>>; defaultRef?: string }
  // U6 deterministic ops (KTD8): OPERATOR-level, executed by the dispatcher
  // fast-path (never by handleRepoCommand, never behind canManageRepos).
  | { verb: "test" | "build"; slug: string; ref?: string }
  | { error: string };

/** Parses `repo <verb> ...` or returns null when the text is not a repo
 *  command. Only the known verbs match — prose like "repo onboarding is
 *  done how?" passes through to the model untouched. */
export function parseRepoCommand(text: string): RepoCommand | null {
  // Slack autoformat turns straight quotes into curly ones; normalize first.
  const normalized = text.trim().replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const m = normalized.match(/^repo\s+(list|onboard|offboard|reconfigure|rebuild|test|build)\b\s*(.*)$/is);
  if (!m) return null;
  const verb = m[1].toLowerCase() as RepoVerb;
  const rest = m[2].trim();

  if (verb === "list") return { verb: "list" };

  // First token is the repo slug; the remainder is key="value" tokens / flags.
  const tokens = rest.match(/[\w-]+="[^"]*"|\S+/g) ?? [];
  const slugToken = tokens.shift();
  const slug = slugToken ? parseSlug(slugToken) : undefined;
  if (!slug) {
    return {
      error: `\`repo ${verb}\` needs a GitHub \`owner/name\` slug, e.g. \`repo ${verb} acme/api\`.`,
    };
  }

  // U6 deterministic ops: `repo test <owner/name> [<ref>]` / `repo build …`.
  // Parsed here so every op has a deterministic invocation the user can reach
  // for when phrasing fails; the dispatcher fast-path executes them. The ref
  // must pass the resident's strict pattern — a hostile ref is a NAMED parse
  // error that never reaches any backend (KTD8).
  if (verb === "test" || verb === "build") {
    if (tokens.length > 1) {
      return { error: `\`repo ${verb}\` takes \`<owner/name> [<ref>]\` only.` };
    }
    let ref: string | undefined;
    if (tokens.length === 1) {
      ref = validRef(tokens[0]);
      if (!ref) return { error: `\`${tokens[0]}\` is not a plausible git branch ref (e.g. \`main\`).` };
    }
    return { verb, slug, ...(ref ? { ref } : {}) };
  }

  if (verb === "offboard" || verb === "rebuild") {
    let dryRun = false;
    for (const t of tokens) {
      if (t === "--dry-run") dryRun = true;
      else return { error: `Unknown option \`${t}\` — \`repo ${verb}\` accepts only \`--dry-run\`.` };
    }
    return { verb, slug, dryRun };
  }

  // onboard / reconfigure: key="value" tokens (test/build/install) + ref=<branch>
  const commands: Partial<Record<CommandKey, string>> = {};
  let defaultRef: string | undefined;
  let evictColdest = false;
  for (const t of tokens) {
    if (t === "--evict-coldest") {
      if (verb !== "onboard") return { error: "`--evict-coldest` applies to `repo onboard` only (it makes room past the resident cap)." };
      evictColdest = true;
      continue;
    }
    const kv = t.match(/^([\w-]+)=("?)(.*)\2$/s);
    if (!kv) {
      return { error: `Couldn't parse \`${t}\`. Use \`ref=<branch>\` or \`test="<cmd>"\` / \`build="<cmd>"\` / \`install="<cmd>"\`.` };
    }
    const [, key, , value] = kv;
    if (key === "ref") {
      const ref = validRef(value);
      if (!ref) return { error: `\`ref=${value}\` is not a plausible git branch ref (e.g. \`ref=main\`).` };
      defaultRef = ref;
    } else if ((COMMAND_KEYS as readonly string[]).includes(key)) {
      if (!value) return { error: `\`${key}=\` needs a non-empty command.` };
      commands[key as CommandKey] = value;
    } else {
      return { error: `Unknown key \`${key}\`. Valid: ref, test, build, install.` };
    }
  }

  if (verb === "onboard") {
    return {
      verb,
      slug,
      commands: { ...DEFAULT_COMMANDS, ...commands },
      defaultRef: defaultRef ?? DEFAULT_REF,
      evictColdest,
    };
  }

  // reconfigure
  if (Object.keys(commands).length === 0 && !defaultRef) {
    return { error: "Nothing to reconfigure. Provide `ref=<branch>` and/or `test=\"…\"` / `build=\"…\"` / `install=\"…\"`." };
  }
  return {
    verb: "reconfigure",
    slug,
    ...(Object.keys(commands).length > 0 ? { commands } : {}),
    ...(defaultRef ? { defaultRef } : {}),
  };
}

// ---- handling -----------------------------------------------------------------

/** Handles a repo command, or returns null when `text` is not one. Replies
 *  are strings in the handleConfigCommand convention. The dispatcher parses
 *  the message ONCE and threads the result in as `cmd`; callers that omit it
 *  get the parse done here. */
export async function handleRepoCommand(
  config: ConfigStore,
  msg: IncomingMessage,
  client?: ResidentAdminClient,
  cmd: RepoCommand | null = parseRepoCommand(msg.text),
): Promise<string | null> {
  if (!cmd) return null;
  if ("error" in cmd) return cmd.error;

  // U6 op verbs are OPERATOR-level and dispatcher-owned: the deterministic
  // ops fast-path gates them with canRunAgent(coding) + canUseRepo (KD7) and
  // executes them modelless — never the admin client, never canManageRepos.
  if (cmd.verb === "test" || cmd.verb === "build") return null;

  // KTD9 fail-closed gate: everything but `list` provisions or destroys
  // billable always-on compute — admins (+ permissions.repoManagement) only.
  if (cmd.verb !== "list" && !config.canManageRepos(msg.userId)) {
    return `🚫 Repo management (\`repo ${cmd.verb}\`) is restricted. Ask ${config.adminsHint()}.`;
  }

  let api = client;
  if (!api) {
    const resident = config.config.execution?.resident;
    if (!resident?.baseUrl) {
      return "Resident repo environments aren't configured — set `execution.resident.baseUrl` in config.yaml.";
    }
    const tokenEnv = resident.adminTokenEnv ?? "RESIDENT_ADMIN_TOKEN";
    const token = process.env[tokenEnv];
    if (!token) return `Repo management needs the resident admin bearer — \`${tokenEnv}\` is not set.`;
    api = makeResidentAdminClient(resident.baseUrl, token);
  }

  try {
    switch (cmd.verb) {
      case "list":
        return renderList(await api.residents());
      case "onboard":
        return renderOnboard(cmd, await api.onboard({
          resource: repoResourceId(cmd.slug),
          commands: cmd.commands,
          defaultRef: cmd.defaultRef,
          ...(cmd.evictColdest ? { evictColdest: true } : {}),
        }));
      case "offboard":
        return renderOffboard(cmd, await api.offboard(repoResourceId(cmd.slug), cmd.dryRun));
      case "rebuild":
        return renderRebuild(cmd, await api.rebuild(repoResourceId(cmd.slug), cmd.dryRun));
      case "reconfigure":
        return handleReconfigure(cmd, api);
    }
  } catch (err) {
    return `⚠️ ${err instanceof Error ? err.message : String(err)}`;
  }
}

const fail = (what: string, r: ResidentAdminResponse): string =>
  `⚠️ ${what} failed (HTTP ${r.status}): ${String(r.data.error ?? "unknown error")}`;

const n = (v: unknown): string => String(typeof v === "number" ? v : (v ?? "?"));

function renderList(r: ResidentAdminResponse): string {
  if (r.status !== 200) return fail("repo list", r);
  const residents = (r.data.residents as Array<Record<string, unknown>> | undefined) ?? [];
  if (residents.length === 0) return `No repos onboarded (0/${n(r.data.cap)}). Onboard one with \`repo onboard <owner/name>\`.`;
  const lines = residents.map((rec) => {
    const live = (rec.live as Record<string, unknown> | undefined) ?? {};
    const slug = String(rec.resource ?? "").replace(/^repo:/, "");
    const state = String(live.state ?? "unknown");
    const reason = String(live.reason ?? "");
    const sha = typeof live.sha === "string" && live.sha ? ` · sha \`${live.sha.slice(0, 8)}\`` : "";
    const refreshed = typeof live.lastRefreshAt === "string" && live.lastRefreshAt ? ` · refreshed ${live.lastRefreshAt}` : "";
    return `• \`${slug}\` — *${state}*${reason ? ` (${reason})` : ""} · ref \`${String(rec.defaultRef ?? "?")}\`${sha}${refreshed}`;
  });
  return [`*Resident repos* (${n(r.data.count)}/${n(r.data.cap)}):`, ...lines].join("\n");
}

function renderOnboard(cmd: { slug: string; commands: Record<CommandKey, string>; defaultRef: string }, r: ResidentAdminResponse): string {
  if (r.status !== 202) {
    // Over the cap with --evict-coldest and nothing eligible: the resident
    // itemizes why each one was kept (#50) — relay it so the admin can
    // offboard by hand with the facts in front of them.
    const rejected = r.status === 429 && Array.isArray(r.data.rejected) ? (r.data.rejected as Array<Record<string, unknown>>) : [];
    const reasons = rejected
      .filter((x) => typeof x.resource === "string" && typeof x.why === "string")
      .map((x) => `• \`${String(x.resource).replace(/^repo:/, "")}\` — ${String(x.why)}`);
    return [fail(`repo onboard ${cmd.slug}`, r), ...reasons].join("\n");
  }
  const lines = [
    `🏗️ Onboarding \`${cmd.slug}\` on \`${cmd.defaultRef}\` — provisioning started (state \`onboarding\`; watch \`repo list\` until it reaches \`warm\`).`,
    `Commands: install \`${cmd.commands.install}\` · build \`${cmd.commands.build}\` · test \`${cmd.commands.test}\``,
  ];
  const evicted = r.data.evicted as Record<string, unknown> | undefined;
  if (evicted && typeof evicted.resource === "string") {
    const errors = Array.isArray(evicted.errors) ? evicted.errors.length : 0;
    lines.push(
      `♻️ Made room: evicted \`${evicted.resource.replace(/^repo:/, "")}\` (coldest warm resident, last used ${String(evicted.lastActivityAt ?? "unknown")}; ` +
        `${n(evicted.backupObjectsDeleted)} backup objects deleted${errors ? `, ${errors} teardown error(s)` : ""}).`,
    );
  }
  if (typeof r.data.warning === "string" && r.data.warning) lines.push(`⚠️ ${r.data.warning}`);
  return lines.join("\n");
}

function renderOffboard(cmd: { slug: string; dryRun: boolean }, r: ResidentAdminResponse): string {
  if (r.status !== 200) return fail(`repo offboard ${cmd.slug}`, r);
  if (cmd.dryRun) {
    const w = (r.data.wouldRemove as Record<string, unknown> | undefined) ?? {};
    const ids = Array.isArray(w.snapshotBackupIds) && w.snapshotBackupIds.length > 0 ? ` (ids ${(w.snapshotBackupIds as string[]).join(", ")})` : "";
    return [
      `🧪 *Dry run* — offboarding \`${cmd.slug}\` would remove:`,
      `• the registry record + ${n(w.schedules)} pending schedule(s)`,
      `• ${n(w.backupObjects)} snapshot backup object(s) in R2${ids}`,
      `• ${n(w.r2Objects)} object(s) under the resident's R2 prefix`,
      `• ${n(w.threadBindings)} thread binding(s) and the container (currently \`${String(w.container ?? "?")}\`)`,
      `Nothing was changed. Run \`repo offboard ${cmd.slug}\` to execute.`,
    ].join("\n");
  }
  const errors = Array.isArray(r.data.errors) ? (r.data.errors as string[]) : [];
  return (
    `🗑️ Offboarded \`${cmd.slug}\`: registry removed ${String(r.data.registryRemoved)}, ` +
    `schedules cancelled ${String(r.data.schedulesCancelled)}, container stopped ${String(r.data.containerStopped)}, ` +
    `storage cleared ${String(r.data.storageCleared)}, ${n(r.data.backupObjectsDeleted)} backup object(s) + ` +
    `${n(r.data.r2ObjectsDeleted)} prefix object(s) deleted from R2` +
    (errors.length > 0 ? `.\n⚠️ Errors: ${errors.join("; ")}` : ".")
  );
}

function renderRebuild(cmd: { slug: string; dryRun: boolean }, r: ResidentAdminResponse): string {
  if (r.status !== 200 && r.status !== 202) return fail(`repo rebuild ${cmd.slug}`, r);
  const discards = (r.data.discards as Record<string, unknown> | undefined) ?? {};
  const snap = discards.snapshot as Record<string, unknown> | null | undefined;
  const reprov = (r.data.reprovision as Record<string, unknown> | undefined) ?? {};
  const keeps = (r.data.keeps as Record<string, unknown> | undefined) ?? {};
  const from = (r.data.from as Record<string, unknown> | undefined) ?? {};
  if (cmd.dryRun) {
    return [
      `🧪 *Dry run* — rebuilding \`${cmd.slug}\` (currently \`${String(from.state ?? "?")}\`${from.reason ? `: ${String(from.reason)}` : ""}) would:`,
      snap
        ? `• discard the snapshot from ${String(snap.createdAt ?? "?")} (${n(discards.backupObjects)} backup object(s); ids ${String(snap.mirrorBackupId ?? "?")}, ${String(snap.checkoutBackupId ?? "?")})`
        : "• discard no snapshot (none recorded)",
      `• reprovision from scratch on \`${String(reprov.defaultRef ?? "?")}\` (budget ${n(reprov.provisioningTimeoutMs)}ms)`,
      `• keep the registry record and ${n(keeps.threadBindings)} thread binding(s)`,
      `Nothing was changed. Run \`repo rebuild ${cmd.slug}\` to execute.`,
    ].join("\n");
  }
  return (
    `🔄 Rebuilding \`${cmd.slug}\`: discarded ${n(r.data.backupObjectsDeleted)} backup object(s); ` +
    `reprovisioning from scratch on \`${String(reprov.defaultRef ?? "?")}\` ` +
    `(state \`onboarding\` — watch \`repo list\` until it reaches \`warm\`).`
  );
}

/** The resident's /reconfigure REPLACES the whole command table (KTD9), so a
 *  partial chat patch is merged onto the current table first — fetched live
 *  from the registry via /residents. */
async function handleReconfigure(
  cmd: { slug: string; commands?: Partial<Record<CommandKey, string>>; defaultRef?: string },
  api: ResidentAdminClient,
): Promise<string> {
  const body: Record<string, unknown> = { resource: repoResourceId(cmd.slug) };
  if (cmd.commands) {
    const list = await api.residents();
    if (list.status !== 200) return fail(`repo reconfigure ${cmd.slug}`, list);
    const residents = (list.data.residents as Array<Record<string, unknown>> | undefined) ?? [];
    const record = residents.find((rec) => rec.resource === repoResourceId(cmd.slug));
    if (!record) return `⚠️ \`${cmd.slug}\` is not onboarded — \`repo onboard ${cmd.slug}\` first.`;
    const current = (record.commands as Record<string, string> | undefined) ?? {};
    body.commands = { ...current, ...cmd.commands };
  }
  if (cmd.defaultRef) body.defaultRef = cmd.defaultRef;
  const r = await api.reconfigure(body);
  if (r.status !== 200) return fail(`repo reconfigure ${cmd.slug}`, r);
  const changed = [
    ...(cmd.defaultRef ? [`ref → \`${cmd.defaultRef}\``] : []),
    ...Object.entries(cmd.commands ?? {}).map(([k, v]) => `${k} → \`${v}\``),
  ].join(", ");
  return `🔧 Reconfigured \`${cmd.slug}\`: ${changed}. Takes effect on the next refresh/attach.`;
}
