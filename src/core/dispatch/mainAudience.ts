import type { McpServerOutcome } from "../../mcp/source.js";
import type { ChatMessage } from "../chatMessage.js";
import type { HistoryItem } from "../types.js";
import type { RunView } from "../runsService.js";
import type { PlaneTable } from "../plane/table.js";
import type { SessionSeed } from "./seed.js";

/** The narrow pilot's answer audience. A private MCP source is usable only
 * from its owner's one-person Slack DM. A shared channel needs a separate
 * source-to-channel grant before its content can be used there. */
export interface MainAudience {
  requester: string;
  channelId: string;
  sources: readonly string[];
}

export type AudienceDecision = { ok: true; audience: MainAudience } | { ok: false; reason: string };

/** The repository names an answered run exposed through GitHub tools, plus
 * the requester's current readable list checked before Slack publication. */
export interface MainGithubReadEvidence {
  repos: readonly string[];
  current: readonly string[];
  unknown: boolean;
}

/** The identities exposed by every plane read in this run, and a fresh view. */
export interface MainPlaneReadEvidence {
  read: boolean;
  exposed: readonly string[];
  current?: readonly string[];
  unknown: boolean;
}

/** A thread work result must be re-read under the same requester before reply. */
export interface MainThreadWorkEvidence {
  exposed: readonly string[];
  current?: string;
}

/** Keep full identities even though the chat table abbreviates run ids. */
export function planeRowIdentities(table: PlaneTable): { rows: string[]; unknown: boolean } {
  const rows: string[] = [];
  let unknown = false;
  for (const row of table.runs) {
    if (typeof row.run?.id === "string" && row.run.id.length > 0) rows.push(`run:${row.run.id}`);
    else unknown = true;
  }
  for (const row of table.units) {
    if (typeof row.unit?.unit === "string" && row.unit.unit.length > 0) rows.push(`unit:${row.unit.unit}`);
    else unknown = true;
  }
  for (const row of table.pullRequests) {
    const { repo, number } = row.pr ?? {};
    if (
      typeof repo === "string" &&
      /^[^/\s]+\/[^/\s]+$/.test(repo) &&
      typeof number === "number" &&
      Number.isInteger(number) &&
      number > 0
    )
      rows.push(`pr:${repo.toLowerCase()}#${number}`);
    else unknown = true;
  }
  return { rows, unknown };
}

/** A reclaimed run can replay old tool results and its original system
 * prompt. Source names alone do not prove the original audience. */
export interface ResumedAudienceEvidence {
  kind: "resume" | "finish";
  messages: readonly ChatMessage[];
  originalToolNames: readonly string[];
  originalAudienceChecked: boolean;
  compacted: boolean;
  requester: string;
  channelId: string;
}

const RECHECK = "I can't safely use earlier source data in this conversation. Please ask me to check the source again.";
const PRIVATE_SOURCE = "I can read this private source only in your one-person Slack DM. Please ask me there.";
const LINKED_CONTEXT =
  "I can't verify that linked conversation's sharing permissions yet. Please ask about the source directly in your DM.";

function sourceOf(toolName: string): string | undefined {
  const match = /^mcp__([a-z0-9-]+)__/.exec(toolName);
  return match?.[1];
}

function servedSources(servers: readonly McpServerOutcome[], requester: string): string[] | undefined {
  const keys: string[] = [];
  for (const server of servers) {
    if (server.toolCount === undefined) continue;
    const key = `user:${requester}/${server.server}`;
    if (server.audience !== key || !server.revision) return undefined;
    keys.push(`${key}@${server.revision}`);
  }
  return keys;
}

function provenPublicResume(resumed: ResumedAudienceEvidence, requester: string, channelId: string): boolean {
  // A finish plan carries no compaction provenance. The old tool catalog
  // records names but not audience grants, so a private source result needs
  // a fresh request, even if today's source has the same name.
  if (
    resumed.kind === "finish" ||
    resumed.compacted ||
    !resumed.originalAudienceChecked ||
    resumed.requester !== requester ||
    resumed.channelId !== channelId ||
    resumed.originalToolNames.some((name) => name.startsWith("mcp__"))
  )
    return false;
  const calls = new Set<string>();
  for (const message of resumed.messages) {
    for (const part of message.content) {
      if (part.type === "tool_use") {
        // Slack link/file access was checked for the prior turn, not this
        // recovered one; the original tool catalog alone carries no grant.
        if (
          part.name.startsWith("mcp__") ||
          part.name.startsWith("github_") ||
          part.name === "plane_show" ||
          part.name === "thread_work" ||
          part.name === "slack_context"
        )
          return false;
        calls.add(part.id);
      }
      // A result without its call means the replay has lost provenance.
      if (part.type === "tool_result" && !calls.has(part.toolUseId)) return false;
    }
  }
  return true;
}

/** Check before any saved thread evidence reaches the main model. The whole
 * un-compacted log is needed to identify every earlier MCP source; if it is
 * cut, a notepad or summary could cite a source we can no longer prove. */
export function mainAudienceAtPrompt(input: {
  requester: string;
  channelId: string;
  verifiedDirectAudience: boolean;
  servers: readonly McpServerOutcome[];
  session?: SessionSeed;
  resumed?: ResumedAudienceEvidence;
  thread?: readonly RunView[];
  history: readonly HistoryItem[];
  threadArtifacts?: string;
  /** A spawned parent's text turns have no durable source provenance. */
  parentSeed?: boolean;
  /** Linked threads/files have a separate source audience. The narrow pilot
   *  does not claim their sharing proof. */
  referencedContext?: boolean;
}): AudienceDecision {
  const directSlack = /^slack:D[A-Z0-9_]+$/.test(input.channelId);
  if (directSlack && !input.verifiedDirectAudience) return { ok: false, reason: PRIVATE_SOURCE };
  if (input.resumed && !provenPublicResume(input.resumed, input.requester, input.channelId))
    return { ok: false, reason: RECHECK };
  if (input.parentSeed) return { ok: false, reason: RECHECK };
  if (input.referencedContext) return { ok: false, reason: LINKED_CONTEXT };
  // Another agent's finished artifact has no durable source labels. Even in
  // the same DM, its sources cannot be rechecked before this model sees it.
  if (input.threadArtifacts) return { ok: false, reason: RECHECK };
  const sources = servedSources(input.servers, input.requester);
  if (!sources) return { ok: false, reason: PRIVATE_SOURCE };
  if (sources.length > 0 && (!directSlack || !input.verifiedDirectAudience))
    return { ok: false, reason: PRIVATE_SOURCE };

  const seed = input.session;
  // A failed ledger read falls back to channel history. Earlier bot words
  // have no source labels there, so they cannot safely seed this agent.
  if (!seed && input.history.some((item) => item.role === "assistant")) return { ok: false, reason: RECHECK };
  if (seed) {
    if (seed.log.from !== 0 || seed.summary !== undefined) return { ok: false, reason: RECHECK };
    const calls = new Set<string>();
    for (const message of seed.messages) {
      for (const part of message.content) {
        if (part.type === "tool_use") {
          // GitHub results lack a durable repository audience. A source's
          // current name alone cannot prove that the requester still holds
          // the repo grant used by an earlier turn.
          if (part.name.startsWith("github_") || part.name === "plane_show" || part.name === "thread_work")
            return { ok: false, reason: RECHECK };
          const source = sourceOf(part.name);
          // A removed source can be replaced under the same name. The old
          // tool result has no source revision, so it must be read afresh.
          if (source) return { ok: false, reason: RECHECK };
          calls.add(part.id);
        }
        if (part.type === "tool_result" && !calls.has(part.toolUseId)) return { ok: false, reason: RECHECK };
      }
    }
  }

  // Saved notes and another run's artifacts can contain a source's answer.
  // Their one-person audience is proven by the owning runs and each visible
  // human turn. Missing authors are unknown, so do not seed them.
  if (sources.length > 0 || seed?.notepad) {
    if (!input.channelId.startsWith("slack:D")) return { ok: false, reason: PRIVATE_SOURCE };
    if (input.history.some((item) => item.role === "user" && item.user !== input.requester))
      return { ok: false, reason: RECHECK };
    if (input.thread?.some((run) => run.userId !== input.requester)) return { ok: false, reason: RECHECK };
  }

  return { ok: true, audience: { requester: input.requester, channelId: input.channelId, sources } };
}

/** Re-resolve the exact source audience immediately before Slack publication.
 * A source that is no longer served for this requester cannot make an
 * earlier answer publishable under a broader audience. */
export function mainAudienceAtReply(
  audience: MainAudience,
  servers: readonly McpServerOutcome[],
  channelId: string,
  requester: string,
  github: MainGithubReadEvidence,
  plane?: MainPlaneReadEvidence,
  verifiedDirectAudience = false,
  threadWork?: MainThreadWorkEvidence,
): AudienceDecision {
  if ((/^slack:D[A-Z0-9_]+$/.test(channelId) || audience.sources.length > 0) && !verifiedDirectAudience)
    return { ok: false, reason: PRIVATE_SOURCE };
  if (channelId !== audience.channelId || requester !== audience.requester) return { ok: false, reason: RECHECK };
  const current = servedSources(servers, requester);
  if (!current || audience.sources.some((key) => !current.includes(key))) return { ok: false, reason: RECHECK };
  if (
    github.unknown ||
    github.repos.some((repo) => !repo || !github.current.some((name) => name.toLowerCase() === repo.toLowerCase()))
  )
    return { ok: false, reason: RECHECK };
  if (plane?.read) {
    if (plane.unknown || !plane.current) return { ok: false, reason: RECHECK };
    const visible = new Set(plane.current);
    if (plane.exposed.some((id) => !visible.has(id))) return { ok: false, reason: RECHECK };
  }
  if (threadWork?.exposed.some((result) => result !== threadWork.current)) return { ok: false, reason: RECHECK };
  return { ok: true, audience };
}
