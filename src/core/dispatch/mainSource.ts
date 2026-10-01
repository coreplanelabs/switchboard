import type { Actor } from "../authz/types.js";
import { PLANE_ACTOR_ID } from "../authz/grants.js";
import { isReissueSteerText } from "../plane/decide.js";
import type { FollowUpInput } from "../threadAdmission.js";
import type { IncomingMessage } from "../types.js";

export type MainSourceFailureCode =
  | "source_compromised"
  | "source_unavailable"
  | "source_quote_missing"
  | "source_quote_mismatch"
  | "authority_store_unavailable"
  | "requester_turn_read_failed"
  | "requester_turn_missing"
  | "requester_turn_superseded"
  | "repository_unconfigured"
  | "repository_mismatch";

export type MainSourceRefusal = { kind: "refused"; reason: MainSourceFailureCode };
export type MainSource = { actor: Actor; msg: IncomingMessage; selectableText: string };
export type MainSourceSelection = { kind: "selected"; source: MainSource } | MainSourceRefusal;
export type MainSourceResolution =
  { kind: "ready"; actor: Actor; msg: IncomingMessage; authorizedRepo: string } | MainSourceRefusal;

/** The model interprets a request. This tracker only binds its tool proposal
 * to the latest delivered, verified person turn in the private pilot DM. */
export class MainSourceTracker {
  private latest: MainSource | undefined;
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

  select(sourceMessage: string): MainSourceSelection {
    const quote = sourceMessage.trim();
    if (this.compromised) return { kind: "refused", reason: "source_compromised" };
    if (!this.latest) return { kind: "refused", reason: "source_unavailable" };
    if (!quote) return { kind: "refused", reason: "source_quote_missing" };
    if (!this.latest.selectableText.includes(quote)) return { kind: "refused", reason: "source_quote_mismatch" };
    return { kind: "selected", source: this.latest };
  }

  get(sourceMessage: string): MainSource | undefined {
    const selected = this.select(sourceMessage);
    return selected.kind === "selected" ? selected.source : undefined;
  }

  /** The first pilot has one configured repository. Model text cannot select
   * a different target or turn a repository cited as evidence into authority. */
  bindRepository(source: MainSource, repo: string, configuredRepo?: string): MainSourceResolution {
    if (!configuredRepo) return { kind: "refused", reason: "repository_unconfigured" };
    if (configuredRepo.toLowerCase() !== repo.toLowerCase()) return { kind: "refused", reason: "repository_mismatch" };
    return { kind: "ready", ...source, authorizedRepo: configuredRepo };
  }

  getWorkRequest(
    sourceMessage: string,
    repo: string,
    configuredRepo?: string,
  ): (MainSource & { authorizedRepo: string }) | undefined {
    const selected = this.select(sourceMessage);
    if (selected.kind === "refused") return undefined;
    const bound = this.bindRepository(selected.source, repo, configuredRepo);
    return bound.kind === "ready" ? { ...selected.source, authorizedRepo: bound.authorizedRepo } : undefined;
  }
}
