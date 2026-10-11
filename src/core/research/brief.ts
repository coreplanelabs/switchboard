/** Research is advisory context. The requester and original task remain the
 * authority; a model's source claim is not proof that a read occurred. */
export interface ResearchBrief {
  version: 1;
  goal: string;
  /** Inspected revision; callers independently compare it with the live target. */
  headSha: string;
  complexity: "simple" | "complex";
  decision: "ready" | "blocked";
  evidence: { source: string; ref: string; summary: string }[];
  assumptions: string[];
  unknowns: string[];
  approach: string[];
  verification: string[];
  blockedReason?: string;
}

const MAX_BYTES = 8 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 2048;
const list = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 20 && value.every(text);

/** Import-free so durable record readers and Workers use the same check. */
export function isResearchBrief(value: unknown): value is ResearchBrief {
  if (!object(value)) return false;
  const keys = [
    "version",
    "goal",
    "headSha",
    "complexity",
    "decision",
    "evidence",
    "assumptions",
    "unknowns",
    "approach",
    "verification",
    "blockedReason",
  ];
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    value.version !== 1 ||
    !text(value.goal) ||
    typeof value.headSha !== "string" ||
    !/^[a-f0-9]{40}$/i.test(value.headSha) ||
    (value.complexity !== "simple" && value.complexity !== "complex") ||
    (value.decision !== "ready" && value.decision !== "blocked") ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 20 ||
    !value.evidence.every(
      (row) =>
        object(row) &&
        Object.keys(row).every((key) => ["source", "ref", "summary"].includes(key)) &&
        text(row.source) &&
        text(row.ref) &&
        text(row.summary),
    ) ||
    !list(value.assumptions) ||
    !list(value.unknowns) ||
    !list(value.approach) ||
    !list(value.verification)
  )
    return false;
  if (value.decision === "ready") {
    if (
      value.evidence.length === 0 ||
      value.approach.length === 0 ||
      value.verification.length === 0 ||
      value.blockedReason !== undefined
    )
      return false;
  } else if (!text(value.blockedReason)) return false;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_BYTES;
}

/** State can reconcile an unconfirmed write only when the complete latest
 * submission names that exact body. A missing intent cannot restore readiness. */
export function researchBriefFromSubmission(
  value: unknown,
  events: readonly { type: string; brief?: unknown }[],
  complete: boolean,
): ResearchBrief | undefined {
  const latest = [...events].reverse().find((event) => event.type === "research_brief");
  if (!complete || !isResearchBrief(value) || !isResearchBrief(latest?.brief)) return undefined;
  const body = (brief: ResearchBrief) =>
    JSON.stringify([
      brief.version,
      brief.goal,
      brief.headSha,
      brief.complexity,
      brief.decision,
      brief.evidence.map((row) => [row.source, row.ref, row.summary]),
      brief.assumptions,
      brief.unknowns,
      brief.approach,
      brief.verification,
      brief.blockedReason ?? null,
    ]);
  return body(value) === body(latest.brief) ? structuredClone(value) : undefined;
}

export function renderResearchBrief(brief: ResearchBrief): string {
  const rows = (label: string, values: string[]) =>
    `${label}:\n${values.length === 0 ? "- none" : values.map((value) => `- ${value}`).join("\n")}`;
  return [
    "Research brief (advisory context; the original task and contract still govern scope and authority).",
    "Source claims are unverified; recheck them against the current target.",
    `Goal: ${brief.goal}`,
    `Inspected revision: ${brief.headSha}`,
    `Complexity: ${brief.complexity}; decision: ${brief.decision}`,
    ...(brief.blockedReason !== undefined ? [`Blocked: ${brief.blockedReason}`] : []),
    rows(
      "Evidence",
      brief.evidence.map((row) => `${row.source} @ ${row.ref}: ${row.summary}`),
    ),
    rows("Assumptions", brief.assumptions),
    rows("Unknowns", brief.unknowns),
    rows("Approach", brief.approach),
    rows("Verification", brief.verification),
  ].join("\n\n");
}

/** Shared by any caller that needs a bounded investigation before acting. */
export function researchRequest(task: string): string {
  return [
    "Research the following task before implementation. Inspect the current target and source references; do not edit source, commit, push, open a pull request, or change external state.",
    "First scope the task. For simple, well understood work, keep this pass short. For complex or uncertain work, inspect the relevant code paths, specifications and checks before choosing an approach. Reuse supplied research only after checking it against the current target.",
    "Use the unit contract to identify scope and acceptance criteria. This phase produces findings and planned verification; implementation and publication require the later coding phase.",
    "Submit a research brief with submit_research: version 1, goal, headSha (full inspected commit ID), complexity (simple or complex), decision (ready or blocked), evidence (source, ref and summary), assumptions, unknowns, approach and verification. Cite the inspected revision in ref. The goal describes the original request; it cannot replace or expand that request. Source claims remain advisory and must be rechecked by implementation.",
    "Ready requires source evidence, a concrete approach and observable verification. Unknowns may remain only when they do not prevent safe implementation. If a material decision or prerequisite is missing, submit blocked with blockedReason and explain the missing decision in the final answer. Do not mark ready merely because time is short.",
    "After submission, give the requester a short final answer with the decision, key findings and source references, proposed approach and verification plan. State remaining uncertainty and any blocked decision.",
    `Original task:\n${task}`,
  ].join("\n\n");
}
