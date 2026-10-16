import { parseDirectives } from "../../directives.js";
import { explicitPrOf } from "../repoContext.js";
import { requesterTargetText, requesterUrlText, requesterUrlWords } from "./requesterText.js";
import { inspectPrTargetEvidence, prUrlIdentity, type PrTargetEvidence } from "./targetEvidence.js";

/** A candidate for empty context, never permission to start an agent. */
export function requestOnlyReviewTarget(text: string): { repo: string; number: number } | undefined {
  const authored = requesterTargetText(text);
  const direct = parseDirectives(authored);
  const raw = parseDirectives(text);
  if (direct.agent !== "review" || raw.agent !== "review") return;
  for (const key of ["agent", "model", "effort", "budget", "severity", "renewals", "verbosity"] as const)
    if (direct[key] !== raw[key]) return;
  const selected = explicitPrOf(authored);
  if (!selected) return;
  const targets = new Set<string>();
  for (const word of requesterUrlWords(authored)) {
    const url = requesterUrlText(word);
    const identity = url ? prUrlIdentity(url) : explicitPrOf(word);
    if (!identity) continue;
    const check = inspectPrTargetEvidence(
      { number: identity.number, source: "request", quote: url ?? word },
      { requestText: authored, repo: identity.repo },
    );
    if (check.ok) targets.add(`${identity.repo}#${identity.number}`);
  }
  return targets.size === 1 && targets.has(`${selected.repo}#${selected.number}`) ? selected : undefined;
}

/** A route must still prove its action and target after the model decision. */
export function isRequestOnlyReviewDecision(
  text: string,
  event:
    | {
        outcome?: string;
        binds?: readonly { line: string; preset?: string; repo?: string; prTarget?: PrTargetEvidence }[];
      }
    | undefined,
): boolean {
  const target = requestOnlyReviewTarget(text);
  if (!target || event?.outcome !== "binds" || event.binds?.length !== 1) return false;
  const bind = event.binds[0]!;
  if (
    bind.preset !== "review" ||
    bind.repo !== target.repo ||
    bind.prTarget?.source !== "request" ||
    bind.prTarget.number !== target.number
  )
    return false;
  return inspectPrTargetEvidence(bind.prTarget, { requestText: requesterTargetText(text), repo: target.repo }).ok;
}
