import {
  SURFACE_CONTEXT_FIELDS,
  SURFACE_ACCESS_FIELDS,
  linearSurfaceOrigin,
  linearSurfaceContext,
  linearSurfaceSourceText,
  linearSurfaceAllows,
  type LinearSurface,
} from "./surfaces.js";
import {
  downloadLinearFiles,
  fileReferences,
  LINEAR_FILE_LIMITS,
  type LinearFile,
  type LinearFileReference,
  copyLinearFile,
  type LinearFileCopy,
} from "./files.js";
import type { StagedFile } from "../../core/types.js";
import { inboundKey } from "../../artifacts/keys.js";
import { LINEAR_TIMING } from "../../core/budgets.js";
import { contentTypeFor } from "../../artifacts/contentType.js";
import type { WorkItemRequest, WorkItemResult } from "../../core/workItems.js";
import { linearPerson, linearTeamAllows } from "./access.js";
import { linearWorkItems, type LinearWorkItemActor } from "./workItems.js";
import type { LinearChildStore } from "./children.js";

export interface LinearOpenedThread {
  organizationId: string;
  sessionId: string;
  url?: string;
}

export interface LinearUpload {
  uploadUrl: string;
  assetUrl: string;
  headers: Record<string, string>;
}

export interface LinearSession {
  id: string;
  appUserId: string;
  creatorId?: string;
  url?: string;
  dismissedAt?: string;
  /** Created through the channel's durable child intent, never webhook text. */
  managedChild?: true;
  comment?: { body: string };
  sourceComment?: { body: string };
  surface?: LinearSurface;
  unsupportedSurface?: true;
  issue?: {
    id: string;
    identifier: string;
    title: string;
    description?: string;
    teamId: string;
    delegateId?: string | null;
  };
}

export type LinearContent =
  | { type: "thought" | "response" | "error" | "elicitation"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string };

export interface LinearActivity {
  id: string;
  at: number;
  userId: string;
  type: string;
  body?: string;
}

/** Bound to one installation. Implementations keep its token at the edge. */
export interface LinearApi {
  openThread(sessionId: string, userId: string, input: { id: string; lead: string }): Promise<LinearOpenedThread>;
  files(
    sessionId: string,
    userId: string,
    urls: string[],
    history?: boolean,
    maxStagedBytes?: number,
  ): Promise<LinearFile[]>;
  copyAttachment?(
    sessionId: string,
    userId: string,
    file: StagedFile,
    key: string,
    signal?: AbortSignal,
  ): Promise<{ key: string; size: number }>;
  canRead(sessionId: string, userId: string): Promise<boolean>;
  session(id: string): Promise<LinearSession>;
  activities(sessionId: string): Promise<LinearActivity[]>;
  activity(sessionId: string, content: LinearContent, options?: { ephemeral?: boolean; id?: string }): Promise<void>;
  link(sessionId: string, link: { url: string; label: string }): Promise<void>;
  upload(sessionId: string, file: { name: string; size: number }): Promise<LinearUpload>;
  workItems(sessionId: string, actor: LinearWorkItemActor, input: WorkItemRequest): Promise<WorkItemResult>;
}

export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export const string = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
export function required(value: unknown): string {
  const result = string(value);
  if (!result) throw new Error("linear_invalid_response");
  return result;
}

const SESSION_QUERY = `query SwitchboardSession($id: String!) {
  organization { id }
  agentSession(id: $id) { id url dismissedAt pullRequest { id } appUser { id } creator { id } comment { id body user { id } ${SURFACE_CONTEXT_FIELDS} }
    sourceComment { body ${SURFACE_CONTEXT_FIELDS} }
    issue { id identifier title description team { id } delegate { id } } }
}`;
const HISTORY_QUERY = `query SwitchboardHistory($id: String!, $before: String) {
  agentSession(id: $id) { activities(last: 100, before: $before, orderBy: createdAt) {
    nodes { id createdAt user { id } content {
      ... on AgentActivityPromptContent { type body }
      ... on AgentActivityResponseContent { type body }
      ... on AgentActivityElicitationContent { type body }
      ... on AgentActivityErrorContent { type body }
    } }
    pageInfo { hasPreviousPage startCursor }
  } }
}`;

/** The only implementation that speaks to Linear. Errors never echo an
 *  upstream body, query variables or the installation's credential. */
export class DirectLinearApi implements LinearApi {
  constructor(
    private readonly deps: {
      organizationId: string;
      appUserId: string;
      children?: LinearChildStore;
      copy?: LinearFileCopy;
      token(): Promise<string>;
      fetch: typeof fetch;
    },
  ) {}

  async openThread(
    parentSessionId: string,
    requesterId: string,
    input: { id: string; lead: string },
  ): Promise<LinearOpenedThread> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id) ||
      typeof input.lead !== "string" ||
      !input.lead.trim() ||
      input.lead.length > 4000
    )
      throw new Error("linear_invalid_child");
    const store = this.deps.children;
    if (!store) throw new Error("linear_children_unavailable");
    if (!(await this.canRead(parentSessionId, requesterId))) throw new Error("linear_child_denied");
    const parent = await this.session(parentSessionId);
    if (!parent.issue || parent.dismissedAt) throw new Error("linear_child_denied");
    const org = this.deps.organizationId,
      issueId = parent.issue.id,
      commentId = input.id;
    await store.ensure({
      organizationId: org,
      appUserId: this.deps.appUserId,
      parentSessionId,
      requesterId,
      issueId,
      commentId,
      lead: input.lead,
    });
    const sessionFields = "id url dismissedAt appUser { id } comment { id } issue { id }";
    const observe = async (): Promise<Record<string, unknown> | undefined> => {
      const data = await this.query(
        `query SwitchboardChildComment($issue: String!, $comment: ID!) {
        organization { id } issue(id: $issue) { id comments(first: 1, filter: { id: { eq: $comment } }) {
          nodes { id body user { id } agentSession { ${sessionFields} } }
        } }
      }`,
        { issue: issueId, comment: commentId },
      );
      const issue = object(data.issue),
        nodes = object(issue.comments).nodes;
      if (object(data.organization).id !== org || issue.id !== issueId || !Array.isArray(nodes) || nodes.length > 1)
        throw new Error("linear_child_conflict");
      if (!nodes.length) return undefined;
      const comment = object(nodes[0]);
      if (comment.id !== commentId || object(comment.user).id !== this.deps.appUserId)
        throw new Error("linear_child_conflict");
      return comment;
    };
    const accept = async (value: unknown): Promise<LinearOpenedThread> => {
      const child = object(value);
      if (
        object(child.appUser).id !== this.deps.appUserId ||
        object(child.comment).id !== commentId ||
        object(child.issue).id !== issueId ||
        child.dismissedAt
      )
        throw new Error("linear_child_conflict");
      const session = { id: required(child.id), ...(string(child.url) ? { url: required(child.url) } : {}) };
      await store.finish(org, commentId, session);
      return { organizationId: org, sessionId: session.id, ...(session.url ? { url: session.url } : {}) };
    };
    let comment = await observe();
    if (!comment) {
      // The caller-chosen UUID makes retrying this comment write idempotent.
      // If its response is lost, read the comment before proceeding.
      try {
        const made = await this.query(
          `mutation SwitchboardCreateChildComment($input: CommentCreateInput!) {
          commentCreate(input: $input) { success comment { id } }
        }`,
          { input: { id: commentId, issueId, body: input.lead } },
        );
        const result = object(made.commentCreate);
        if (result.success !== true || object(result.comment).id !== commentId)
          throw new Error("linear_invalid_response");
      } catch {
        comment = await observe();
        if (!comment) throw new Error("linear_child_creation_uncertain");
      }
      // Creating the comment can itself trigger a session. Observe it before
      // asking Linear to create one explicitly, and verify the comment owner.
      comment ??= await observe();
      if (!comment) throw new Error("linear_child_creation_uncertain");
    }
    if (comment?.agentSession) {
      // A session may already exist on the comment. Record that fact without
      // attempting another creation, including when the comment triggered it.
      await store.beginSession(org, commentId);
      return accept(comment.agentSession);
    }
    if (!(await store.beginSession(org, commentId))) {
      const found = await observe();
      if (found?.agentSession) return accept(found.agentSession);
      throw new Error("linear_child_creation_uncertain");
    }
    try {
      const made = await this.query(
        `mutation SwitchboardCreateChildSession($input: AgentSessionCreateOnComment!) {
        agentSessionCreateOnComment(input: $input) { success agentSession { ${sessionFields} } }
      }`,
        { input: { commentId } },
      );
      const result = object(made.agentSessionCreateOnComment);
      if (result.success !== true) throw new Error("linear_invalid_response");
      return await accept(result.agentSession);
    } catch {
      const found = await observe();
      if (found?.agentSession) return accept(found.agentSession);
      throw new Error("linear_child_creation_uncertain");
    }
  }

  async canRead(sessionId: string, userId: string, signal?: AbortSignal): Promise<boolean> {
    const data = await this.query(
      `query SwitchboardSessionAccess($id: String!) {
      organization { id }
      agentSession(id: $id) { id dismissedAt pullRequest { id } appUser { id }
        comment { ${SURFACE_ACCESS_FIELDS} } sourceComment { ${SURFACE_ACCESS_FIELDS} }
        issue { team { id visibility restrictedBy { id } } } }
    }`,
      { id: sessionId },
      signal,
    );
    const session = object(data.agentSession);
    if (
      object(data.organization).id !== this.deps.organizationId ||
      session.id !== sessionId ||
      object(session.appUser).id !== this.deps.appUserId ||
      session.dismissedAt
    )
      return false;
    const team = object(object(session.issue).team);
    if (!string(team.id) && !linearSurfaceOrigin(session)) return false;
    try {
      const person = await linearPerson(
        {
          organizationId: this.deps.organizationId,
          appUserId: this.deps.appUserId,
          query: (query, variables) => this.query(query, variables, signal),
        },
        { id: userId, actions: [] },
      );
      return string(team.id)
        ? linearTeamAllows(person, "conversation:read", team)
        : linearSurfaceAllows(
            {
              organizationId: this.deps.organizationId,
              appUserId: this.deps.appUserId,
              query: (query, variables) => this.query(query, variables, signal),
            },
            person,
            session,
          );
    } catch (error) {
      if (error instanceof Error && error.message === "linear_human_required") return false;
      throw error;
    }
  }

  private async fileContext(
    sessionId: string,
    userId: string,
    urls: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, LinearFileReference>> {
    if (!Array.isArray(urls) || urls.length > 1000 || urls.some((url) => typeof url !== "string" || url.length > 4096))
      throw new Error("linear_invalid_files");
    if (!urls.length) return new Map();
    if (!(await this.canRead(sessionId, userId, signal))) throw new Error("linear_file_denied");
    const requested = [...new Set(urls)];
    const wanted = new Set(requested);
    const allowed = new Map<string, LinearFileReference>();
    const collect = (value: unknown) => {
      if (typeof value === "string")
        for (const ref of fileReferences(value))
          if (wanted.has(ref.url) && !allowed.has(ref.url)) allowed.set(ref.url, ref);
    };
    let after: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; ; page++) {
      if (page >= 100) throw new Error("linear_file_context_too_large");
      const data = await this.query(
        `query SwitchboardFileContext($id: String!, $after: String) {
        organization { id }
        agentSession(id: $id) { id dismissedAt pullRequest { id } appUser { id } comment { body ${SURFACE_CONTEXT_FIELDS} }
          sourceComment { body ${SURFACE_CONTEXT_FIELDS} }
          issue { description comments(first: 100, after: $after) { nodes { body } pageInfo { hasNextPage endCursor } } } }
      }`,
        { id: sessionId, after },
        signal,
      );
      const session = object(data.agentSession);
      if (
        object(data.organization).id !== this.deps.organizationId ||
        session.id !== sessionId ||
        object(session.appUser).id !== this.deps.appUserId ||
        session.dismissedAt
      )
        throw new Error("linear_file_denied");
      const issue = object(session.issue);
      collect(issue.description);
      collect(object(session.comment).body);
      collect(linearSurfaceSourceText(session));
      collect(linearSurfaceContext(session)?.content);
      if (!session.issue) break;
      const comments = object(issue.comments);
      if (!Array.isArray(comments.nodes)) throw new Error("linear_invalid_response");
      for (const comment of comments.nodes) collect(object(comment).body);
      const info = object(comments.pageInfo);
      if (info.hasNextPage === false) break;
      after = required(info.endCursor);
      if (cursors.has(after)) throw new Error("linear_invalid_pagination");
      cursors.add(after);
    }
    for (const activity of await this.activities(sessionId, signal)) collect(activity.body);
    return allowed;
  }

  async files(
    sessionId: string,
    userId: string,
    urls: string[],
    history = false,
    maxStagedBytes = 0,
  ): Promise<LinearFile[]> {
    if (!Number.isSafeInteger(maxStagedBytes) || maxStagedBytes < 0) throw new Error("linear_invalid_files");
    const allowed = await this.fileContext(sessionId, userId, urls);
    const requested = [...new Set(urls)];
    const downloaded = await downloadLinearFiles(
      requested.flatMap((url) => (allowed.has(url) ? [allowed.get(url)!] : [])),
      { ...this.deps, maxStagedBytes: this.deps.copy && !history ? maxStagedBytes : 0 },
      history ? LINEAR_FILE_LIMITS.historyCount : LINEAR_FILE_LIMITS.count,
    );
    const byUrl = new Map(downloaded.map((file) => [file.url, file]));
    return requested.map(
      (url) => byUrl.get(url) ?? { url, name: "attachment", skipped: "not found in current session context" },
    );
  }

  async copyAttachment(
    sessionId: string,
    userId: string,
    file: StagedFile,
    key: string,
    signal?: AbortSignal,
  ): Promise<{ key: string; size: number }> {
    signal?.throwIfAborted();
    if (!this.deps.copy) throw new Error("linear_staging_unavailable");
    const index = typeof key === "string" ? Number(/\/(\d+)-[^/]+$/.exec(key)?.[1]) : NaN;
    if (
      !file ||
      typeof file.url !== "string" ||
      typeof file.name !== "string" ||
      !file.name ||
      file.name.length > 255 ||
      typeof file.messageId !== "string" ||
      !/^[A-Za-z0-9:_-]{1,512}$/.test(file.messageId) ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.size > LINEAR_FILE_LIMITS.stagedFileBytes ||
      !Number.isSafeInteger(index) ||
      index < 1 ||
      key !== inboundKey(`linear:${this.deps.organizationId}:${sessionId}`, file.messageId, index, file.name)
    )
      throw new Error("linear_invalid_files");
    const ref = (await this.fileContext(sessionId, userId, [file.url], signal)).get(file.url);
    if (!ref) throw new Error("linear_file_denied");
    return copyLinearFile(ref, file, key, { ...this.deps, copy: this.deps.copy, signal });
  }

  workItems(_sessionId: string, actor: LinearWorkItemActor, input: WorkItemRequest): Promise<WorkItemResult> {
    return linearWorkItems(
      { organizationId: this.deps.organizationId, appUserId: this.deps.appUserId, query: this.query.bind(this) },
      actor,
      input,
    );
  }

  private async query(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const token = await this.deps.token();
    let response: Response;
    try {
      response = await this.deps.fetch("https://api.linear.app/graphql", {
        method: "POST",
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(LINEAR_TIMING.apiTimeoutMs)])
          : AbortSignal.timeout(LINEAR_TIMING.apiTimeoutMs),
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      throw new Error("linear_api_unavailable");
    }
    if (!response.ok) throw new Error(response.status === 429 ? "linear_rate_limited" : "linear_api_unavailable");
    let payload: Record<string, unknown>;
    try {
      payload = object(await response.json());
    } catch {
      throw new Error("linear_invalid_response");
    }
    if (payload.errors) throw new Error("linear_api_error");
    if (!payload.data) throw new Error("linear_invalid_response");
    return object(payload.data);
  }

  async session(id: string): Promise<LinearSession> {
    const data = await this.query(SESSION_QUERY, { id });
    const session = object(data.agentSession);
    if (object(data.organization).id !== this.deps.organizationId || object(session.appUser).id !== this.deps.appUserId)
      throw new Error("linear_wrong_installation");
    if (session.id !== id) throw new Error("linear_invalid_response");
    const issue = object(session.issue);
    const surface = linearSurfaceContext(session);
    const sourceComment = linearSurfaceSourceText(session);
    const childComment = string(object(session.comment).id);
    const child = childComment ? await this.deps.children?.get(this.deps.organizationId, childComment) : undefined;
    const managedChild =
      child &&
      child.appUserId === this.deps.appUserId &&
      object(object(session.comment).user).id === this.deps.appUserId &&
      child.issueId === issue.id &&
      (!child.session || child.session.id === id);
    return {
      id,
      appUserId: this.deps.appUserId,
      ...(surface ? { surface } : !session.issue ? { unsupportedSurface: true as const } : {}),
      ...(sourceComment ? { sourceComment: { body: sourceComment } } : {}),
      ...(managedChild ? { managedChild: true as const } : {}),
      ...(string(object(session.creator).id) ? { creatorId: string(object(session.creator).id) } : {}),
      ...(string(session.url) ? { url: string(session.url) } : {}),
      ...(string(session.dismissedAt) ? { dismissedAt: string(session.dismissedAt) } : {}),
      ...(string(object(session.comment).body) ? { comment: { body: required(object(session.comment).body) } } : {}),
      ...(session.issue
        ? {
            issue: {
              id: required(issue.id),
              identifier: required(issue.identifier),
              title: required(issue.title),
              teamId: required(object(issue.team).id),
              delegateId: string(object(issue.delegate).id) ?? null,
              ...(string(issue.description) ? { description: string(issue.description) } : {}),
            },
          }
        : {}),
    };
  }

  async activities(sessionId: string, signal?: AbortSignal): Promise<LinearActivity[]> {
    const rows = new Map<string, LinearActivity>();
    let before: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const data = await this.query(HISTORY_QUERY, { id: sessionId, before }, signal);
      const connection = object(object(data.agentSession).activities);
      if (!Array.isArray(connection.nodes)) throw new Error("linear_invalid_response");
      for (const node of connection.nodes) {
        const row = object(node),
          content = object(row.content);
        // Thoughts and actions have no fragment in this query: progress is not conversation.
        if (!string(content.type)) continue;
        const id = required(row.id),
          at = Date.parse(required(row.createdAt));
        if (!Number.isFinite(at)) throw new Error("linear_invalid_response");
        rows.set(id, {
          id,
          at,
          userId: required(object(row.user).id),
          type: required(content.type),
          body: string(content.body),
        });
      }
      const info = object(connection.pageInfo);
      if (info.hasPreviousPage === false)
        return [...rows.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
      before = required(info.startCursor);
      if (seen.has(before)) throw new Error("linear_invalid_pagination");
      seen.add(before);
    }
    throw new Error("linear_history_too_large");
  }

  async activity(
    sessionId: string,
    content: LinearContent,
    options: { ephemeral?: boolean; id?: string } = {},
  ): Promise<void> {
    try {
      const data = await this.query(
        `mutation SwitchboardActivity($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) { success }
    }`,
        { input: { agentSessionId: sessionId, content, ...options } },
      );
      if (object(data.agentActivityCreate).success !== true) throw new Error("linear_activity_failed");
    } catch (error) {
      if (!options.id) throw error;
      // A create may have committed even when its response was lost. A stable
      // id lets the caller retry without treating a duplicate as a new activity.
      // Never accept an existing id belonging to different work or content.
      try {
        const data = await this.query(
          `query SwitchboardActivityReceipt($id: String!) {
          agentActivity(id: $id) { id agentSession { id } user { id } content {
            ... on AgentActivityThoughtContent { type body }
            ... on AgentActivityResponseContent { type body }
            ... on AgentActivityErrorContent { type body }
            ... on AgentActivityElicitationContent { type body }
            ... on AgentActivityActionContent { type action parameter result }
          } }
        }`,
          { id: options.id },
        );
        const activity = object(data.agentActivity),
          saved = object(activity.content);
        if (
          activity.id === options.id &&
          object(activity.agentSession).id === sessionId &&
          object(activity.user).id === this.deps.appUserId &&
          Object.entries(content).every(([key, value]) => saved[key] === value)
        )
          return;
      } catch {
        /* The original operation's sanitized failure is the retry signal. */
      }
      throw error;
    }
  }

  async link(sessionId: string, link: { url: string; label: string }): Promise<void> {
    const data = await this.query(
      `mutation SwitchboardLink($id: String!, $input: AgentSessionUpdateInput!) {
      agentSessionUpdate(id: $id, input: $input) { success }
    }`,
      { id: sessionId, input: { addedExternalUrls: [link] } },
    );
    if (object(data.agentSessionUpdate).success !== true) throw new Error("linear_session_update_failed");
  }

  async upload(sessionId: string, file: { name: string; size: number }): Promise<LinearUpload> {
    if (
      !file.name ||
      file.name.length > 255 ||
      /[/\\]/.test(file.name) ||
      [...file.name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.size > 2 ** 30
    )
      throw new Error("linear_invalid_file");
    const contentType = contentTypeFor(file.name);
    const data = await this.query(
      `mutation SwitchboardUpload($contentType: String!, $filename: String!, $size: Int!, $metaData: JSON) {
      fileUpload(contentType: $contentType, filename: $filename, size: $size, makePublic: false, metaData: $metaData) {
        success uploadFile { uploadUrl assetUrl headers { key value } }
      }
    }`,
      { contentType, filename: file.name, size: file.size, metaData: { agentSessionId: sessionId } },
    );
    const payload = object(data.fileUpload),
      upload = object(payload.uploadFile);
    if (payload.success !== true) throw new Error("linear_upload_failed");
    const secureUrl = (value: unknown): string => {
      const url = new URL(required(value));
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("linear_invalid_response");
      return url.href;
    };
    const uploadUrl = secureUrl(upload.uploadUrl),
      assetUrl = secureUrl(upload.assetUrl);
    if (!Array.isArray(upload.headers)) throw new Error("linear_invalid_response");
    const headers: Record<string, string> = Object.create(null);
    const names = new Set<string>();
    for (const entry of upload.headers) {
      const row = object(entry),
        key = required(row.key),
        value = required(row.value);
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(value) || names.has(key.toLowerCase()))
        throw new Error("linear_invalid_response");
      names.add(key.toLowerCase());
      headers[key] = value;
    }
    if (!names.has("content-type")) headers["Content-Type"] = contentType;
    if (!names.has("cache-control")) headers["Cache-Control"] = "public, max-age=31536000";
    return { uploadUrl, assetUrl, headers };
  }
}
