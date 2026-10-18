import { parseDirectives } from "../../directives.js";
import { explicitPrOf } from "../repoContext.js";
import { requesterTargetText, requesterUrlText, requesterUrlWords } from "./requesterText.js";
import { inspectPrTargetEvidence, prUrlIdentity, type PrTargetEvidence } from "./targetEvidence.js";

/** Fresh context is a one-request control, never inferred from a review target. */
export function freshReviewRequested(text: string): boolean {
  const controls: string[] = [];
  for (const token of requesterTargetText(text).trimStart().split(/\s+/)) {
    const control = /^(agent|model|effort|budget|severity|renewals|verbosity|review-head|review-context)[:=](.*)$/.exec(
      token,
    );
    if (!control) break;
    if (control[1] === "review-context") controls.push(control[2]!);
  }
  return controls.length === 1 && controls[0] === "fresh";
}

/** A candidate for empty context, never permission to start an agent. */
export function requestOnlyPrTarget(
  text: string,
): { repo: string; number: number; preset: "review" | "ship" } | undefined {
  const authored = requesterTargetText(text);
  const direct = parseDirectives(authored);
  const raw = parseDirectives(text);
  if ((direct.agent !== "review" && direct.agent !== "ship") || raw.agent !== direct.agent) return;
  if (direct.agent === "ship" && !/^(?:review-context[:=]fresh\s+)?review\s/i.test(direct.text.trimStart())) return;
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
  return targets.size === 1 && targets.has(`${selected.repo}#${selected.number}`)
    ? { ...selected, preset: direct.agent }
    : undefined;
}

/** A route must still prove its action and target after the model decision. */
export function isRequestOnlyPrDecision(
  text: string,
  event:
    | {
        outcome?: string;
        binds?: readonly {
          line: string;
          preset?: string;
          repo?: string;
          prTarget?: PrTargetEvidence;
          shipEntry?: string;
        }[];
      }
    | undefined,
): boolean {
  const target = requestOnlyPrTarget(text);
  if (!target || event?.outcome !== "binds" || event.binds?.length !== 1) return false;
  const bind = event.binds[0]!;
  if (
    bind.preset !== target.preset ||
    (target.preset === "ship" && bind.shipEntry !== "review") ||
    bind.repo !== target.repo ||
    bind.prTarget?.source !== "request" ||
    bind.prTarget.number !== target.number
  )
    return false;
  return inspectPrTargetEvidence(bind.prTarget, { requestText: requesterTargetText(text), repo: target.repo }).ok;
}
