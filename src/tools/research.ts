import { isResearchBrief } from "../core/research/brief.js";
import { redactSecrets } from "../core/redact.js";
import type { RunnableTool } from "./runnableTool.js";

const strings = { type: "array", items: { type: "string" }, maxItems: 20 };

export const submitResearchTool: RunnableTool = {
  name: "submit_research",
  failsInText: true,
  description:
    "Save a bounded research brief on this run before implementation. Cite the inspected full commit ID in headSha " +
    "and source references in evidence. Ready requires evidence, approach and observable verification; blocked requires " +
    "blockedReason. Assumptions and unknowns remain explicit. This brief is advisory and never replaces the original " +
    "request or grants permission to act. A later valid submission replaces this run's brief.",
  inputSchema: {
    type: "object",
    properties: {
      version: { type: "integer", enum: [1] },
      goal: { type: "string" },
      headSha: { type: "string", pattern: "^[a-fA-F0-9]{40}$" },
      complexity: { type: "string", enum: ["simple", "complex"] },
      decision: { type: "string", enum: ["ready", "blocked"] },
      evidence: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: { source: { type: "string" }, ref: { type: "string" }, summary: { type: "string" } },
          required: ["source", "ref", "summary"],
          additionalProperties: false,
        },
      },
      assumptions: strings,
      unknowns: strings,
      approach: strings,
      verification: strings,
      blockedReason: { type: "string" },
    },
    required: [
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
    ],
    additionalProperties: false,
  },
  async run(input, ctx) {
    let brief: unknown;
    try {
      brief = JSON.parse(
        JSON.stringify(input, (_key, value: unknown) => (typeof value === "string" ? redactSecrets(value) : value)),
      );
    } catch {
      return "error: invalid research brief";
    }
    if (!isResearchBrief(brief))
      return "error: invalid research brief — version 1, full headSha, bounded lists and source references are required; ready needs evidence, approach and verification; blocked needs blockedReason";
    const sink = ctx.onResearchBrief;
    if (!sink) return "error: this run has no research brief recorder";
    try {
      if (!(await sink(brief))) return "error: research brief retention was not confirmed";
    } catch {
      return "error: research brief retention was not confirmed";
    }
    return brief.decision === "blocked"
      ? `Research brief recorded; implementation is blocked: ${brief.blockedReason}`
      : `Research brief recorded (${brief.complexity}); source claims remain advisory.`;
  },
};
