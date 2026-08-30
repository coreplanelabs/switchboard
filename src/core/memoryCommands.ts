import type { ConfigStore } from "../config.js";
import { requestScopeKeys, selectMemoryStore } from "./memory/index.js";
import type { MemoryRecord, MemoryStore } from "./memory/types.js";
import type { IncomingMessage } from "./types.js";

// Human controls over cross-session memory (#278, #293; features/memory.md
// §24): `memory list [me|org] [--limit <n>] [<words>]` and `memory forget
// <id>`. Config-family like `friction …`: answered inline from the store, never
// a model turn, channel-agnostic. Scope gate: a person manages their OWN
// `user:` scope freely; the shared org scope is admin-gated (the same fail-
// closed `canManageRepos` gate as repo management); another user's scope is
// unreachable for everyone — the only scopes a request can name are its own
// and the org's (invariant 4).

/** Records shown per scope by `memory list` when no `--limit` is given. */
export const MEMORY_LIST_LIMIT = 20;
/** Ceiling for `--limit` — the Memory Worker's per-request cap. */
export const MEMORY_LIST_MAX_LIMIT = 50;

export type MemoryCommand =
  | { verb: "list"; scope: "all" | "me" | "org"; limit?: number; query?: string }
  | { verb: "forget"; id: string }
  | { error: string };

const USAGE = "Usage: `memory list [me|org] [--limit <n>] [<words>]` · `memory forget <id>`";

/** Parses a memory command; null when the text is not one (prose mentioning
 *  memory passes through to the model). `memory list` takes an optional scope
 *  word first, then `--limit <n>` (or `--limit=<n>`) anywhere; every other word
 *  is part of the text filter. */
export function parseMemoryCommand(text: string): MemoryCommand | null {
  const m = text.trim().match(/^memory\s+(\S+)\s*(.*)$/is);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const rest = m[2].trim();
  if (verb === "list") {
    const cmd: Extract<MemoryCommand, { verb: "list" }> = { verb: "list", scope: "all" };
    const tokens = rest.split(/\s+/).filter(Boolean);
    const words: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const flag = /^--limit(?:=(.*))?$/.exec(t);
      if (flag) {
        const raw = flag[1] ?? tokens[++i];
        if (raw === undefined) return { error: `\`--limit\` needs a value: an integer between 1 and ${MEMORY_LIST_MAX_LIMIT}.` };
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > MEMORY_LIST_MAX_LIMIT) {
          return { error: `\`--limit\` expects an integer between 1 and ${MEMORY_LIST_MAX_LIMIT}, got \`${raw}\`.` };
        }
        cmd.limit = n;
        continue;
      }
      if (t.startsWith("--")) return { error: `Unknown option \`${t}\`. ${USAGE}` };
      const lower = t.toLowerCase();
      if (words.length === 0 && cmd.scope === "all" && cmd.limit === undefined && (lower === "me" || lower === "org")) {
        cmd.scope = lower;
        continue;
      }
      words.push(t);
    }
    if (words.length > 0) cmd.query = words.join(" ");
    return cmd;
  }
  if (verb === "forget") {
    if (rest === "" || /\s/.test(rest)) return { error: `${USAGE} — \`memory forget <id>\` takes exactly one record id.` };
    return { verb: "forget", id: rest };
  }
  return { error: `Unknown memory command \`${verb}\`. ${USAGE}` };
}

/** `mem:<scopeKey>:<seq>` → the scope key it belongs to (the id format minted
 *  by `mintRecord`); undefined when the id is not a memory id. */
export function scopeKeyOfMemoryId(id: string): string | undefined {
  const m = /^mem:(.+):\d+$/.exec(id);
  return m ? m[1] : undefined;
}

/** The reply plus whether the command did what was asked (`ok: false` for a
 *  refusal, a miss, or a store failure) — the run record (#244) uses `ok`. */
export interface MemoryCommandResult {
  text: string;
  ok: boolean;
}

/** Runs a parsed memory command. Never throws: store failures come back as a
 *  ⚠️ line with `ok: false`. */
export async function runMemoryCommand(
  config: ConfigStore,
  msg: IncomingMessage,
  store: MemoryStore | undefined,
  cmd: MemoryCommand,
): Promise<MemoryCommandResult> {
  if ("error" in cmd) return { text: cmd.error, ok: false };
  const cfg = config.config.memory;
  if (!cfg?.enabled) {
    return { text: "Memory is off in this deployment (`memory.enabled` is not set), so there is nothing to list or forget.", ok: false };
  }
  const keys = requestScopeKeys(msg.userId);
  const s = selectMemoryStore(cfg, store);

  try {
    if (cmd.verb === "list") {
      const view = { limit: cmd.limit ?? MEMORY_LIST_LIMIT, query: cmd.query };
      const sections: string[] = [];
      if (cmd.scope !== "org") {
        sections.push(
          keys.user
            ? await renderScope(s, keys.user, "your records", view)
            : "*your records*: this request carries no user identity, so there is no personal scope to show.",
        );
      }
      if (cmd.scope !== "me") sections.push(await renderScope(s, keys.org, "shared org records", view));
      return { text: sections.join("\n\n"), ok: true };
    }

    // forget — resolve the target scope FROM the id, then gate on it.
    const target = scopeKeyOfMemoryId(cmd.id);
    if (!target) {
      return { text: `\`${cmd.id}\` is not a memory id — ids look like \`mem:<scope>:<n>\` (see \`memory list\`).`, ok: false };
    }
    if (target === keys.user) {
      // own scope: always allowed
    } else if (target === keys.org) {
      if (!config.canManageRepos(msg.userId)) {
        return {
          text: `🚫 Forgetting shared org memory is restricted. Ask ${config.adminsHint()} — you can always forget records in your own scope (\`memory list me\`).`,
          ok: false,
        };
      }
    } else {
      return {
        text: `🚫 You can only forget records in your own scope${config.canManageRepos(msg.userId) ? " or the org scope" : ""} — \`${cmd.id}\` belongs to another user's scope, which no one can reach from here.`,
        ok: false,
      };
    }
    const forgotten = await s.forget(target, cmd.id);
    return forgotten
      ? { text: `🧹 Forgot \`${cmd.id}\` (\`${target}\`). It no longer influences any run; the row is kept for provenance.`, ok: true }
      : { text: `Nothing to forget: no active record \`${cmd.id}\` in \`${target}\`.`, ok: false };
  } catch (err) {
    return { text: `⚠️ ${err instanceof Error ? err.message : String(err)}`, ok: false };
  }
}

/** Reply-only view of `runMemoryCommand`; null when `msg.text` is not a memory command. */
export async function handleMemoryCommand(
  config: ConfigStore,
  msg: IncomingMessage,
  store: MemoryStore | undefined,
  cmd: MemoryCommand | null = parseMemoryCommand(msg.text),
): Promise<string | null> {
  if (!cmd) return null;
  return (await runMemoryCommand(config, msg, store, cmd)).text;
}

async function renderScope(
  store: MemoryStore,
  scopeKey: string,
  label: string,
  view: { limit: number; query?: string },
): Promise<string> {
  const records = await store.list(scopeKey, view.limit, view.query);
  const filter = view.query !== undefined ? ` matching \`${view.query}\`` : "";
  const head = `*${label}* (\`${scopeKey}\`)${filter}`;
  if (records.length === 0) return `${head}: no active records.`;
  // A full page may or may not hide more (no probe fetch) — say exactly that.
  const more =
    records.length === view.limit
      ? `\n_(limit ${view.limit} reached — there may be more; narrow with words or raise \`--limit\`, max ${MEMORY_LIST_MAX_LIMIT})_`
      : "";
  return [head, ...records.map(renderRecord)].join("\n") + more;
}

/** One record per line. The source thread key goes in a code span: as italics
 *  it collided with mrkdwn's `_` handling and rendered mangled (#293). */
function renderRecord(r: MemoryRecord): string {
  const when = new Date(r.createdAt).toISOString().slice(0, 10);
  return `• \`${r.id}\` [${r.kind}, ${when}] ${r.text} (source: \`${r.sourceThreadKey}\`)`;
}
