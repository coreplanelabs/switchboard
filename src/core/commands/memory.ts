import { z } from "zod";
import { CommandError, commandDefiner, wrapUntrusted, type Caller, type CommandDef, type CommandRegistry, type JsonObject, type JsonValue } from "../commandRegistry.js";
import { deriveScopeKey, requestScopeKeys, selectMemoryStore } from "../memory/index.js";
import type { MemoryConfig, MemoryRecord, MemoryStore } from "../memory/types.js";

// The `memory.*` registrations (#278, #293, #253, phase 4b): the human controls
// over cross-session memory, on the typed model.
//   memory list [query…] [--scope <me|org|repo|channel|all>] [--limit <n>] [--repo owner/name]
//   memory forget <id>
// Caller-scoped on EVERY surface: the only user scope a caller can list or
// forget is its own (`requestScopeKeys(caller.id)` — `user:slack:U…` for a
// Slack person, `user:cli:local` for the CLI, `user:mcp:<subject>` for a
// machine caller); the channel scope is the channel the caller speaks from
// (`caller.origin`), the repo scope the repo the thread is bound to (resolved
// lazily through `caller.origin.repo`, or named with `--repo`); the shared
// scopes (org, repo, channel) are listed by everyone and forgotten only by an
// org admin (chat: the fail-closed repo-management set; `cli:local` holds every
// scope); another user's scope is unreachable for anyone (isolation by
// construction, invariant 4). Never a model turn, never a run started here
// (KTD16); the dispatcher records `memory forget` as an inline run.

export interface MemoryCommandDeps {
  memory: {
    /** The live `memory` config section (read per call: config reloads). */
    config(): MemoryConfig | undefined;
    /** The process's store (index.ts shares the one the reflection pass writes
     *  to); absent → the in-process fallback `selectMemoryStore` picks. */
    store?: MemoryStore;
  };
}

const defineCommand = commandDefiner<MemoryCommandDeps>();

/** Records shown per scope by `memory list` when no `--limit` is given. */
export const MEMORY_LIST_LIMIT = 20;
/** Ceiling for `--limit` — the Memory Worker's per-request cap. */
export const MEMORY_LIST_MAX_LIMIT = 50;

export const MEMORY_OFF_MESSAGE = "Memory is off in this deployment (`memory.enabled` is not set), so there is nothing to list or forget.";

/** `mem:<scopeKey>:<seq>` → the scope key it belongs to (the id format minted
 *  by `mintRecord`); undefined when the id is not a memory id. */
export function scopeKeyOfMemoryId(id: string): string | undefined {
  const m = /^mem:(.+):\d+$/.exec(id);
  return m ? m[1] : undefined;
}

const memoryId = z.string().refine((id) => scopeKeyOfMemoryId(id) !== undefined, "expected a memory id like mem:<scope>:<n> (see `memory list`)");

function storeOf(deps: MemoryCommandDeps): MemoryStore {
  const cfg = deps.memory.config();
  if (!cfg?.enabled) throw new CommandError("unavailable", MEMORY_OFF_MESSAGE);
  return selectMemoryStore(cfg, deps.memory.store);
}

/** Store failures are the store being unreachable — named, never `internal`. */
async function viaStore<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new CommandError("unavailable", err instanceof Error ? err.message : String(err));
  }
}

/** Whether this caller may forget SHARED records (org, repo, channel): the
 *  local CLI (every scope) or a chat caller the fail-closed repo-management
 *  gate admits. */
function isOrgAdmin(caller: Caller): boolean {
  return caller.scopes === "all" || caller.chatGate?.("repoManager") === true;
}

/** The shared scope keys (#253) — the same derivers the read/write paths use. */
const repoScopeKey = (repo: string) => deriveScopeKey("repo", { repo });
const channelScopeKey = (channelId: string) => deriveScopeKey("channel", { channelId });
const isSharedScope = (key: string, keys: { org: string }) => key === keys.org || key.startsWith("repo:") || key.startsWith("channel:");

export const LIST_SCOPES = ["me", "org", "repo", "channel", "all"] as const;

interface ListedScope {
  key: string;
  label: string;
  records: MemoryRecord[];
  /** The page was full — there may be more (no probe fetch). */
  limitReached: boolean;
}

/** One record per line. The source thread key goes in a code span: as italics
 *  it collided with mrkdwn's `_` handling and rendered mangled (#293). */
function renderRecord(r: JsonObject): string {
  const when = typeof r.createdAt === "number" ? new Date(r.createdAt).toISOString().slice(0, 10) : "?";
  return `• \`${String(r.id)}\` [${String(r.kind)}, ${when}] ${String(r.text)} (source: \`${String(r.sourceThreadKey)}\`)`;
}

function renderList(output: JsonValue): string {
  const o = output as JsonObject;
  const query = typeof o.query === "string" ? o.query : undefined;
  const limit = typeof o.limit === "number" ? o.limit : MEMORY_LIST_LIMIT;
  const filter = query !== undefined ? ` matching \`${query}\`` : "";
  const sections: string[] = [];
  const missing = Array.isArray(o.missing) ? o.missing : [];
  if (missing.includes("me")) sections.push("*your records*: this request carries no user identity, so there is no personal scope to show.");
  if (missing.includes("repo")) sections.push("*this repo's records*: no repo is bound here — name one (`--repo owner/name`, or ask in a repo thread).");
  if (missing.includes("channel")) sections.push("*this channel's records*: this request carries no channel identity.");
  for (const s of (Array.isArray(o.scopes) ? o.scopes : []).map((v) => v as JsonObject)) {
    const records = Array.isArray(s.records) ? s.records.map((r) => r as JsonObject) : [];
    const head = `*${String(s.label)}* (\`${String(s.key)}\`)${filter}`;
    if (records.length === 0) {
      sections.push(`${head}: no active records.`);
      continue;
    }
    const more = s.limitReached === true ? `\n_(limit ${limit} reached — there may be more; narrow with words or raise \`--limit\`, max ${MEMORY_LIST_MAX_LIMIT})_` : "";
    sections.push([head, ...records.map(renderRecord)].join("\n") + more);
  }
  return sections.join("\n\n");
}

export const memoryList = defineCommand({
  id: "memory.list",
  args: [{ name: "query", schema: z.string().optional(), describe: "words a record must mention (whole-token match)", rest: true }],
  options: z.object({
    scope: z.enum(LIST_SCOPES).optional().describe("which scopes to list (default all: yours, this repo's, this channel's, and the shared org scope)"),
    limit: z.coerce.number().int().min(1).max(MEMORY_LIST_MAX_LIMIT).optional().describe(`records per scope (default ${MEMORY_LIST_LIMIT}, max ${MEMORY_LIST_MAX_LIMIT})`),
    repo: z
      .string()
      .refine((s) => /^[\w.-]+\/[\w.-]+$/.test(s), "expected an owner/name slug")
      .optional()
      .describe("the repo whose scope to list (default: the repo this thread is bound to)"),
  }),
  scope: "memory:read",
  chatGate: "open",
  effect: "read",
  describe: "Your own memory records and the shared org / repo / channel records, with ids — what influences your runs.",
  render: renderList,
  handler: async ({ args, options, caller, deps }) => {
    const store = storeOf(deps);
    const keys = requestScopeKeys(caller.id);
    // #344: the chat-documented "scope word first" form (`memory list org
    // deploy`). A leading bare scope word is the scope when --scope is absent;
    // an explicit --scope keeps every query word as filter text. A first word
    // that is not a scope name is never consumed.
    let query = args.query;
    let scope: (typeof LIST_SCOPES)[number] = options.scope ?? "all";
    if (options.scope === undefined && query !== undefined) {
      const [first, ...rest] = query.split(/\s+/).filter(Boolean);
      if ((LIST_SCOPES as readonly string[]).includes(first)) {
        scope = first as (typeof LIST_SCOPES)[number];
        query = rest.length > 0 ? rest.join(" ") : undefined;
      }
    }
    const limit = options.limit ?? MEMORY_LIST_LIMIT;
    const want = (s: (typeof LIST_SCOPES)[number]) => scope === "all" || scope === s;
    const wanted: Array<{ key: string; label: string }> = [];
    const missing: string[] = [];
    if (want("me")) {
      if (keys.user) wanted.push({ key: keys.user, label: "your records" });
      else missing.push("me");
    }
    if (want("repo")) {
      // The repo scope costs a resolution (history + GitHub) — paid only when asked for.
      const repo = options.repo ?? (await caller.origin?.repo?.());
      if (repo) wanted.push({ key: repoScopeKey(repo), label: "this repo's records" });
      else if (scope === "repo") missing.push("repo");
    }
    if (want("channel")) {
      if (caller.origin) wanted.push({ key: channelScopeKey(caller.origin.channelId), label: "this channel's records" });
      else if (scope === "channel") missing.push("channel");
    }
    if (want("org")) wanted.push({ key: keys.org, label: "shared org records" });
    const scopes: ListedScope[] = [];
    for (const w of wanted) {
      const records = await viaStore(() => store.list(w.key, limit, query));
      scopes.push({ ...w, records, limitReached: records.length === limit });
    }
    // Stored free text leaves machine surfaces wrapped (KTD17); chat renders it as the person's own records.
    const wrap = caller.kind === "chat" ? (t: string) => t : wrapUntrusted;
    return {
      ...(query !== undefined ? { query } : {}),
      limit,
      ...(missing.length > 0 ? { missing } : {}),
      scopes: scopes.map((s) => ({ ...s, records: s.records.map((r) => ({ ...r, text: wrap(r.text) })) })) as unknown as JsonValue,
    };
  },
});

export const memoryForget = defineCommand({
  id: "memory.forget",
  args: [{ name: "id", schema: memoryId, describe: "the record id (`mem:<scope>:<n>`, from `memory list`)" }],
  scope: "memory:write",
  chatGate: "open",
  effect: "write",
  describe: "Soft-delete one memory record so it no longer influences any run (yours freely; shared org/repo/channel records need repo-management rights).",
  render: (output) => {
    const o = output as JsonObject;
    return `🧹 Forgot \`${String(o.id)}\` (\`${String(o.scope)}\`). It no longer influences any run; the row is kept for provenance.`;
  },
  handler: async ({ args, caller, deps }) => {
    const store = storeOf(deps);
    const keys = requestScopeKeys(caller.id);
    const target = scopeKeyOfMemoryId(args.id) as string;
    if (target === keys.user) {
      // own scope: always allowed
    } else if (isSharedScope(target, keys)) {
      if (!isOrgAdmin(caller)) throw new CommandError("unauthorized", "Forgetting shared memory (org, repo, channel) needs repo-management rights — you can always forget records in your own scope (`memory list --scope me`).");
    } else {
      throw new CommandError("unauthorized", `You can only forget records in your own scope${isOrgAdmin(caller) ? " or the org scope" : ""} — \`${args.id}\` belongs to another user's scope, which no one can reach from here.`);
    }
    const forgotten = await viaStore(() => store.forget(target, args.id));
    if (!forgotten) throw new CommandError("not_found", `Nothing to forget: no active record \`${args.id}\` in \`${target}\`.`);
    return { id: args.id, scope: target, forgotten: true };
  },
});

export const memoryCommands: readonly CommandDef<MemoryCommandDeps>[] = [memoryList, memoryForget] as unknown as CommandDef<MemoryCommandDeps>[];

export function registerMemoryCommands<D extends MemoryCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of memoryCommands) registry.register(cmd as unknown as CommandDef<D>);
}
