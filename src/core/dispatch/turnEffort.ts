// The effort of a model turn that is not a preset run (routing-and-config
// item 2; memory.md item 11): the operator's, the router's, the intake gate's
// and the reflection extractor's. Each of the four reads its own config key
// beside its model key and applies it through the SAME model-card path a
// preset's effort takes — `resolveModelCard` over the config's provider
// blocks and the installed registry, then `decideControls` on the levels map:
// a named tier goes out vouched with its wire word, an unnamed one degrades to
// the highest named tier below it, unknown levels send the tier's own word
// unvouched — and a refused tier (or a ref no card resolves) drops the effort
// with a note for the caller's log line, so the background turn still runs at
// the model's own default rather than failing over a tuning key. Unset means
// no decision at all: the request is byte-identical to before the key existed.

import type { Effort } from "../../effort.js";
import { decideControls, resolveModelCard, type CardRegistry } from "../modelCard.js";
import { installedModelRegistry } from "../installedModelRegistry.js";
import type { ProviderConfig } from "../provider.js";

/** What rides the completion request when the card lets the tier through. */
export interface TurnEffortRequest {
  /** The configured tier, for provenance and any provider that maps it itself. */
  effort: Effort;
  /** The wire word the card decided for the tier (`ControlDecision.applied`). */
  effortWord: string;
}

/** The decision: `request` when the effort goes out (vouched or degraded),
 *  absent when none was configured or the card refused; `note` says why a
 *  configured tier was degraded or dropped, for the caller's log line. */
export interface TurnEffort {
  request?: TurnEffortRequest;
  note?: string;
}

/**
 * One turn's effort against its model's card. `tier` undefined → no decision
 * (the provider's own default, as before the key existed). Never throws: a
 * ref whose card cannot resolve drops the effort with the error as the note —
 * these are background turns whose model call must still be attempted.
 */
export function turnEffort(
  ref: string,
  tier: Effort | undefined,
  providers: Readonly<Record<string, ProviderConfig>>,
  registry: CardRegistry = installedModelRegistry,
): TurnEffort {
  if (tier === undefined) return {};
  try {
    const card = resolveModelCard(ref, providers, registry);
    const decision = decideControls(card, { effort: tier }).find((d) => d.control === "effort");
    if (!decision || decision.outcome === "refused")
      return { note: `effort "${tier}" dropped: ${decision?.why ?? "the card decided nothing for it"}` };
    return {
      request: { effort: tier, effortWord: decision.applied ?? tier },
      ...(decision.why ? { note: decision.why } : {}),
    };
  } catch (err) {
    return { note: `effort "${tier}" dropped: ${err instanceof Error ? err.message : String(err)}` };
  }
}
