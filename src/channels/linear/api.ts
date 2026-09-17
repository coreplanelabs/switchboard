import { LINEAR_TIMING } from "../../core/budgets.js";
import { contentTypeFor } from "../../artifacts/contentType.js";
import type { WorkItemRequest, WorkItemResult } from "../../core/workItems.js";
import { linearWorkItems, type LinearWorkItemActor } from "./workItems.js";

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
  agentSession(id: $id) { id url dismissedAt appUser { id } creator { id }
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
      token(): Promise<string>;
      fetch: typeof fetch;
    },
  ) {}

  workItems(_sessionId: string, actor: LinearWorkItemActor, input: WorkItemRequest): Promise<WorkItemResult> {
    return linearWorkItems(
      { organizationId: this.deps.organizationId, appUserId: this.deps.appUserId, query: this.query.bind(this) },
      actor,
      input,
    );
  }

  private async query(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = await this.deps.token();
    let response: Response;
    try {
      response = await this.deps.fetch("https://api.linear.app/graphql", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(LINEAR_TIMING.apiTimeoutMs),
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
    return {
      id,
      appUserId: this.deps.appUserId,
      ...(string(object(session.creator).id) ? { creatorId: string(object(session.creator).id) } : {}),
      ...(string(session.url) ? { url: string(session.url) } : {}),
      ...(string(session.dismissedAt) ? { dismissedAt: string(session.dismissedAt) } : {}),
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

  async activities(sessionId: string): Promise<LinearActivity[]> {
    const rows = new Map<string, LinearActivity>();
    let before: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const data = await this.query(HISTORY_QUERY, { id: sessionId, before });
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
