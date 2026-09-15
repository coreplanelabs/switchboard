import type { Actor } from "./types.js";

/**
 * The actor the `conversation:read` row is asked for (record 0037): the
 * requester's identity holding exactly one channel membership, its origin
 * channel, and none of its own grants. `member-of` then reads as the rule the
 * record states — a public channel from anywhere, a private channel only from
 * inside it — and an admin's `all` is not consulted, because pointing the bot
 * at a thread is not an admin act. `reflectionActor`'s construction without
 * the principal's grants; the principal is copied, never mutated, and
 * `onBehalfOf` is dropped because the question is about the requester alone.
 */
export function pointingActor(principal: Actor, originChannelId: string): Actor {
  const { onBehalfOf: _dropped, ...identity } = principal;
  return {
    ...identity,
    grants: {
      actions: new Set<string>(),
      channels: new Set([originChannelId]),
      repos: new Set<string>(),
    },
  };
}
