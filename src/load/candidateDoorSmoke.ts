import { presetBindOf } from "../core/dispatch/operator.js";
import type { OperatorBind, OperatorInput } from "../core/dispatch/operator.js";

export interface CandidateDoorSmokeCase {
  name: string;
  text: string;
  context?: Partial<OperatorInput>;
  expected: (bind: OperatorBind) => boolean;
}

/** Fixed synthetic decisions only; this scope has no run store or execution. */
export function candidateDoorSmokeCases(projection: OperatorInput["projection"]): CandidateDoorSmokeCase[] {
  return [
    {
      name: "ordinary read",
      text: "What is 2 + 2? Answer in one sentence.",
      expected: (bind: OperatorBind) =>
        presetBindOf(
          bind.line,
          projection.presets.map((preset) => preset.name),
        ) === "general" &&
        bind.effort === undefined &&
        bind.budget === undefined &&
        bind.verbosity === undefined,
    },
    {
      name: "read about review severity",
      text: "What does 'major findings' mean in a review report? Answer in one sentence.",
      expected: (bind: OperatorBind) =>
        presetBindOf(
          bind.line,
          projection.presets.map((preset) => preset.name),
        ) === "general" && bind.severity === undefined,
    },
    {
      name: "existing PR review",
      text: "agents:ship please review https://github.com/acme/api/pull/7",
      expected: (bind: OperatorBind) =>
        bind.shipEntry === "review" &&
        bind.repo === "acme/api" &&
        bind.prTarget?.number === 7 &&
        bind.prTarget.quote === "https://github.com/acme/api/pull/7" &&
        bind.workObjective === undefined,
    },
    {
      name: "standalone PR review",
      text: "agent:review review https://github.com/acme/api/pull/7 at head 1111111111111111111111111111111111111111. Focus on the Door boundary.",
      expected: (bind: OperatorBind) =>
        presetBindOf(
          bind.line,
          projection.presets.map((preset) => preset.name),
        ) === "review" &&
        bind.repo === "acme/api" &&
        bind.prTarget?.number === 7 &&
        bind.prTarget.quote === "https://github.com/acme/api/pull/7",
    },
    {
      name: "review with requested renewals",
      text: "Review https://github.com/acme/api/pull/7 with two renewals.",
      expected: (bind: OperatorBind) =>
        bind.shipEntry === "review" &&
        bind.repo === "acme/api" &&
        bind.prTarget?.number === 7 &&
        bind.prTarget.quote === "https://github.com/acme/api/pull/7" &&
        bind.renewals === 2,
    },
    {
      name: "requested run settings",
      text: "Use high effort and a 25 minute budget; show debug detail. What is 2 + 2? Answer in one sentence.",
      expected: (bind: OperatorBind) =>
        presetBindOf(
          bind.line,
          projection.presets.map((preset) => preset.name),
        ) === "general" &&
        bind.effort === "high" &&
        bind.budget === 25 &&
        bind.verbosity === "debug",
    },
    {
      name: "same-thread fix with historical foreign PR",
      text: "Fix it.",
      context: {
        requesterId: "slack:UPILOT",
        requesterTarget: {
          repo: "acme/api",
          issue: "acme/api#42",
          provenance: "Investigate https://github.com/acme/api/issues/42",
        },
        tail: [
          {
            actor: "slack:UPILOT",
            text: "user: Investigate https://github.com/acme/api/issues/42 and explain the failure.",
          },
          {
            actor: "slack:UBOT",
            text: "assistant: Issue 42 is unresolved; https://github.com/acme/old/pull/7 is historical context.",
          },
        ],
      },
      expected: (bind: OperatorBind) =>
        bind.shipEntry === "work_from_thread" &&
        bind.repo === "acme/api" &&
        bind.repoSource === "thread" &&
        bind.prTarget === undefined,
    },
  ];
}

export function candidateDoorSmokeInput(
  probe: CandidateDoorSmokeCase,
  projection: OperatorInput["projection"],
  provider: string,
): OperatorInput {
  return { ...probe.context, text: probe.text, projection, tail: probe.context?.tail ?? [], providers: [provider] };
}
