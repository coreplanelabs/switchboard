const privateConversation = Symbol("private-conversation");

/** Server-only context. Internal message copies retain this marker; JSON and
 * durable grant snapshots cannot supply it. The host restores it from the
 * original ingress destination after resolving current authority on recovery. */
export function markPrivateConversation<T extends object>(message: T): T {
  return { ...message, [privateConversation]: true };
}
export function isPrivateConversation(message: object): boolean {
  return (message as { [privateConversation]?: boolean })[privateConversation] === true;
}
