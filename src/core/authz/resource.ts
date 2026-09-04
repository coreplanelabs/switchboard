// What a condition may read off a resource (plan U1, KTD1).
//
// Every condition in the closed vocabulary relates the actor to ONE resource
// attribute: `member-of` → channelId, `is-self` → userId, `owner-of` → repo,
// a `has-grant` placeholder → the named attribute. `TARGET_ATTRIBUTES` states
// which attributes each resource target (type, or type/kind for the kinded
// resources) can carry, so `validatePolicy` can refuse a row that reads an
// attribute its resource never has — at module load, not at request time.

import type { ChannelVisibility, KindOf, Resource, ResourceType } from "./types.js";

export interface ResourceAttributes {
  readonly channelId?: string;
  readonly userId?: string;
  /** `owner/name`. */
  readonly repo?: string;
  /** Agent name. */
  readonly name?: string;
  /** Visibility of the channel the resource originated in; absent → `unknown` (fail-closed, KTD7). */
  readonly visibility: ChannelVisibility;
}

export type AttributeName = Exclude<keyof ResourceAttributes, "visibility">;

/** The kinds each kinded resource type takes. Types absent here are not kinded. */
export const RESOURCE_KINDS: { readonly [T in ResourceType]?: readonly KindOf<T>[] } = {
  "memory-scope": ["org", "user", "repo", "channel"],
  "config-scope": ["channel", "user"],
};

/** A resource type, or `type/kind` for the kinded ones — the unit a rule row targets. */
export type Target =
  | Exclude<ResourceType, "memory-scope" | "config-scope">
  | `memory-scope/${"org" | "user" | "repo" | "channel"}`
  | `config-scope/${"channel" | "user"}`;

export const TARGET_ATTRIBUTES: Readonly<Record<Target, readonly AttributeName[]>> = {
  run: ["channelId", "userId", "repo"],
  channel: ["channelId"],
  "memory-scope/org": [],
  "memory-scope/user": ["userId"],
  "memory-scope/channel": ["channelId"],
  "memory-scope/repo": ["repo"],
  repo: ["repo"],
  "config-scope/channel": ["channelId"],
  "config-scope/user": ["userId"],
  agent: ["name"],
  command: [],
};

export const RESOURCE_TYPES: readonly ResourceType[] = ["run", "channel", "memory-scope", "repo", "config-scope", "agent", "command"];

export const CHANNEL_VISIBILITIES: readonly ChannelVisibility[] = ["public", "private", "dm", "machine", "unknown"];

/** The target a rule row names; `undefined` when the (type, kind) pair is not a valid target. */
export function targetOf(type: string, kind?: string): Target | undefined {
  const kinds: readonly string[] | undefined = RESOURCE_KINDS[type as ResourceType];
  if (kinds) {
    if (kind === undefined || !kinds.includes(kind)) return undefined;
    return `${type}/${kind}` as Target;
  }
  if (kind !== undefined) return undefined;
  return type in TARGET_ATTRIBUTES ? (type as Target) : undefined;
}

export function targetOfResource(resource: Resource): Target {
  const kind = "kind" in resource ? resource.kind : undefined;
  const target = targetOf(resource.type, kind);
  if (!target) throw new TypeError(`authz: no target for resource type ${resource.type}`);
  return target;
}

/** Strip `<prefix>:` from a memory-scope key; `undefined` when the key is not of that prefix
 *  (the condition then fails — a malformed key never widens access). */
function scopeId(key: string, prefix: "user" | "channel" | "repo"): string | undefined {
  const head = `${prefix}:`;
  return key.startsWith(head) && key.length > head.length ? key.slice(head.length) : undefined;
}

export function attributesOf(resource: Resource): ResourceAttributes {
  switch (resource.type) {
    case "run":
      return {
        channelId: resource.channelId,
        userId: resource.userId,
        ...(resource.repo !== undefined ? { repo: resource.repo } : {}),
        visibility: resource.channelVisibility ?? "unknown",
      };
    case "channel":
      return { channelId: resource.id, visibility: resource.visibility };
    case "memory-scope": {
      const visibility = resource.originChannelVisibility ?? "unknown";
      switch (resource.kind) {
        case "org":
          return { visibility };
        case "user": {
          const userId = scopeId(resource.key, "user");
          return userId === undefined ? { visibility } : { userId, visibility };
        }
        case "channel": {
          const channelId = scopeId(resource.key, "channel");
          return channelId === undefined ? { visibility } : { channelId, visibility };
        }
        case "repo": {
          const repo = scopeId(resource.key, "repo");
          return repo === undefined ? { visibility } : { repo, visibility };
        }
      }
      break;
    }
    case "repo":
      return { repo: `${resource.owner}/${resource.name}`, visibility: "unknown" };
    case "config-scope":
      return resource.kind === "channel"
        ? { channelId: resource.id, visibility: "unknown" }
        : { userId: resource.id, visibility: "unknown" };
    case "agent":
      return { name: resource.name, visibility: "unknown" };
    case "command":
      return { visibility: "unknown" };
  }
  return { visibility: "unknown" };
}
