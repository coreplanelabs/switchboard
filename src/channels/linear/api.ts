import { LINEAR_TIMING } from "../../core/budgets.js";

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
    const data = await this.query(
      `mutation SwitchboardActivity($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) { success }
    }`,
      { input: { agentSessionId: sessionId, content, ...options } },
    );
    if (object(data.agentActivityCreate).success !== true) throw new Error("linear_activity_failed");
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
}
