import type { Actor } from "../authz/types.js";
import { PLANE_ACTOR_ID } from "../authz/grants.js";
import { isReissueSteerText } from "../plane/decide.js";
import type { FollowUpInput } from "../threadAdmission.js";
import type { IncomingMessage } from "../types.js";

type Source = { actor: Actor; msg: IncomingMessage; selectableText: string };

/** The model interprets a request. This tracker only binds its tool proposal
 * to the latest delivered, verified person turn in the private pilot DM. */
export class MainSourceTracker {
  private latest: Source | undefined;
  private compromised = false;

  constructor(
    initial: IncomingMessage,
    private readonly actorOf: (msg: IncomingMessage) => Actor,
  ) {
    this.latest = { actor: actorOf(initial), msg: initial, selectableText: initial.text };
  }

  accept(inputs: readonly FollowUpInput[]): void {
    for (const input of inputs) {
      if (input.userId === PLANE_ACTOR_ID && isReissueSteerText(input.text)) continue;
      const audience = input.directAudience;
      const previous = this.latest;
      if (
        !previous ||
        input.from ||
        input.postedBy ||
        input.authenticatedAs ||
        input.messageId === undefined ||
        input.userId !== previous.msg.userId ||
        audience?.kind !== "slack-unshared-im" ||
        audience.channelId !== previous.msg.channelId ||
        audience.userId !== input.userId ||
        audience.threadKey !== previous.msg.threadKey
      ) {
        this.compromised = true;
        this.latest = undefined;
        return;
      }
      if (this.compromised) return;
      const msg: IncomingMessage = {
        channelId: previous.msg.channelId,
        threadKey: previous.msg.threadKey,
        userId: input.userId,
        directAudience: audience,
        text: input.text,
        messageId: input.messageId,
        receivedAt: input.at,
        ...(input.userName !== undefined ? { userName: input.userName } : {}),
        ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
      };
      this.latest = { actor: this.actorOf(msg), msg, selectableText: input.text };
    }
  }

  get(sourceMessage: string): Source | undefined {
    const quote = sourceMessage.trim();
    if (this.compromised || !quote || !this.latest?.selectableText.includes(quote)) return undefined;
    return this.latest;
  }

  /** The first pilot has one configured repository. Model text cannot select
   * a different target or turn a repository cited as evidence into authority. */
  getWorkRequest(
    sourceMessage: string,
    repo: string,
    configuredRepo?: string,
  ): (Source & { authorizedRepo: string }) | undefined {
    const source = this.get(sourceMessage);
    if (!source || !configuredRepo || configuredRepo.toLowerCase() !== repo.toLowerCase()) return undefined;
    return { ...source, authorizedRepo: configuredRepo };
  }
}
