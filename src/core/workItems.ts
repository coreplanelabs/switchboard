/** Channel-neutral work tracking. The channel binds identity outside tool input. */
export interface WorkItem {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  priority: number;
  state: { id: string; name: string; type: string };
  availableStates?: { id: string; name: string; type: string }[];
  teamId: string;
  assignee?: { id: string; name: string };
  delegate?: { id: string; name: string };
}

export type WorkItemRequest =
  | { op: "get"; id: string }
  | { op: "delegated"; after?: string; limit?: number }
  | { op: "update"; id: string; title?: string; description?: string; priority?: number; state?: string }
  | { op: "create_child"; parentId: string; title: string; description?: string }
  | { op: "comment"; id: string; body: string };

export type WorkItemResult = WorkItem | { items: WorkItem[]; nextCursor?: string } | { url: string };

export interface WorkItems {
  request(input: WorkItemRequest): Promise<WorkItemResult>;
}
