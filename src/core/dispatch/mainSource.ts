import type { Actor } from "../authz/types.js";
import { PLANE_ACTOR_ID } from "../authz/grants.js";
import { isReissueSteerText } from "../plane/decide.js";
import { followUpMessageId, type FollowUpInput } from "../threadAdmission.js";
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

export type MainSourceRefusal = { kind: "refused"; reason: MainSourceFailureCode; retryQuote?: string };
export type MainSource = { actor: Actor; msg: IncomingMessage; selectableText: string };
export type MainSourceSelection = { kind: "selected"; source: MainSource } | MainSourceRefusal;
export type MainSourceResolution =
  { kind: "ready"; actor: Actor; msg: IncomingMessage; authorizedRepo: string } | MainSourceRefusal;

/** Bind a proposal to the latest delivered requester turn. Private tools
 * separately require fresh proof of their one-person audience. */
export class MainSourceTracker {
  private latest: MainSource | undefined;
  private compromised = false;

  constructor(
    initial: IncomingMessage,
    private readonly actorOf: (msg: IncomingMessage) => Actor,
  ) {
    if (initial.mergedFollowUps) this.revoke();
    else this.latest = { actor: actorOf(initial), msg: initial, selectableText: initial.text };
  }

  revoke(): void {
    this.compromised = true;
    this.latest = undefined;
  }

  /** Queued input can withdraw authority before delivery. It cannot select
   * a new request until the runtime confirms that delivery. */
  observe(input: FollowUpInput): boolean {
    if (input.userId === PLANE_ACTOR_ID && isReissueSteerText(input.text)) return false;
    const previous = this.latest;
    const audience = input.directAudience;
    const expected = previous?.msg.directAudience;
    if (
      this.compromised ||
      !previous ||
      input.from ||
      input.mergedFollowUps ||
      (input.messageId === undefined &&
        (expected !== undefined || !Number.isSafeInteger(input.ledgerSeq) || Number(input.ledgerSeq) <= 0)) ||
      input.userId !== previous.msg.userId ||
      input.postedBy !== previous.msg.postedBy ||
      input.authenticatedAs !== previous.msg.authenticatedAs ||
      input.relayedBy !== previous.msg.relayedBy ||
      (expected
        ? audience?.kind !== expected.kind ||
          audience.channelId !== expected.channelId ||
          audience.userId !== expected.userId ||
          audience.threadKey !== expected.threadKey
        : audience !== undefined)
    ) {
      this.revoke();
      return false;
    }
    return true;
  }

  accept(inputs: readonly FollowUpInput[]): void {
    for (const input of inputs) {
      if (!this.observe(input)) continue;
      const previous = this.latest!;
      const msg: IncomingMessage = {
        channelId: previous.msg.channelId,
        threadKey: previous.msg.threadKey,
        userId: input.userId,
        ...(input.approvalConnection !== undefined ? { approvalConnection: input.approvalConnection } : {}),
        text: input.text,
        messageId: followUpMessageId(input),
        receivedAt: input.at,
        ...(input.directAudience !== undefined ? { directAudience: input.directAudience } : {}),
        ...(input.postedBy !== undefined ? { postedBy: input.postedBy } : {}),
        ...(input.authenticatedAs !== undefined ? { authenticatedAs: input.authenticatedAs } : {}),
        ...(input.relayedBy !== undefined ? { relayedBy: input.relayedBy } : {}),
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
    if (!this.latest.selectableText.includes(quote)) {
      // A literal from the current delivered turn lets the private model
      // correct a copy error without changing who or what authorized work.
      const firstLine =
        this.latest.selectableText
          .split(/\r?\n/)
          .find((line) => line.trim())
          ?.trim() ?? "";
      return {
        kind: "refused",
        reason: "source_quote_mismatch",
        ...(firstLine ? { retryQuote: firstLine.slice(0, 64) } : {}),
      };
    }
    return { kind: "selected", source: this.latest };
  }

  get(sourceMessage: string): MainSource | undefined {
    const selected = this.select(sourceMessage);
    return selected.kind === "selected" ? selected.source : undefined;
  }

  current(): MainSource | undefined {
    return this.compromised ? undefined : this.latest;
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
