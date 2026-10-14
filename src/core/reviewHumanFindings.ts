import { z } from "zod";

const text = z.string().trim().min(1);
const location = z
  .object({
    file: z
      .string()
      .min(1)
      .refine(
        (p) => !p.startsWith("/") && !p.split("/").includes("..") && !/[\s\\`<>[\]]|:\/\//.test(p),
        "file must be a repository-relative path",
      ),
    line: z.number().int().positive().optional(),
  })
  .strict();
const humanFinding = z
  .object({
    findingId: z
      .string()
      .min(1)
      .refine((id) => id === id.trim()),
    problem: text,
    scenario: text,
    impact: text,
    evidence: z
      .object({
        basis: z.enum(["code_trace", "isolated_reproduction", "deployed_reproduction", "repository_rule"]),
        detail: text,
      })
      .strict(),
    requestedChange: text,
    location,
  })
  .strict();

export type HumanFinding = z.infer<typeof humanFinding>;

export const HUMAN_FINDINGS_INSTRUCTION =
  "For every active finding, including priorFindings, supply humanFindings keyed by its exact findingId: current problem, concrete scenario and reachability conditions, user impact, evidence {basis, detail}, requestedChange and current-head location {file, line?}. State whether evidence is a code_trace, isolated_reproduction, deployed_reproduction, or repository_rule; name reproduction environments and never imply a code trace was reproduced. Use plain short sentences, at most 900 visible characters in total per finding. Explain rare but consequential failures without inventing frequency. Keep the original finding metadata stable; update this human explanation and location after partial fixes. Supply [] for a review with no findings.";

/** Shared JSON schema for the native and load review tool declarations. */
export const humanFindingsInputSchema = {
  type: "array",
  description: HUMAN_FINDINGS_INSTRUCTION,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["findingId", "problem", "scenario", "impact", "evidence", "requestedChange", "location"],
    properties: {
      findingId: { type: "string" },
      problem: { type: "string" },
      scenario: { type: "string" },
      impact: { type: "string" },
      requestedChange: { type: "string" },
      evidence: {
        type: "object",
        additionalProperties: false,
        required: ["basis", "detail"],
        properties: {
          basis: {
            type: "string",
            enum: ["code_trace", "isolated_reproduction", "deployed_reproduction", "repository_rule"],
          },
          detail: { type: "string" },
        },
      },
      location: {
        type: "object",
        additionalProperties: false,
        required: ["file"],
        properties: { file: { type: "string" }, line: { type: "integer", minimum: 1 } },
      },
    },
  },
};

export function humanFindingsProblem(value: unknown, ids: readonly string[], bounded = true): string | undefined {
  const parsed = z.array(humanFinding).safeParse(value);
  if (!parsed.success)
    return `humanFindings: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
  const seen = new Set<string>();
  for (const row of parsed.data) {
    if (seen.has(row.findingId) || !ids.includes(row.findingId))
      return `humanFindings: duplicate or unknown findingId ${row.findingId}`;
    seen.add(row.findingId);
    const length = [...[row.problem, row.scenario, row.impact, row.evidence.detail, row.requestedChange].join(" ")]
      .length;
    if (bounded && length > 900)
      return `humanFindings: ${row.findingId} has ${length} visible characters; shorten to at most 900`;
  }
  const missing = ids.filter((id) => !seen.has(id));
  return missing.length ? `humanFindings: missing explanations for ${missing.join(", ")}` : undefined;
}

/** Plain text cannot introduce headings, links or close the agent evidence fold. */
export const humanText = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_{}[\]<>#|!~]/g, "\\$&");

export function humanExplanation(row: HumanFinding): string {
  const basis = {
    code_trace: "Code trace",
    isolated_reproduction: "Isolated reproduction",
    deployed_reproduction: "Deployed reproduction",
    repository_rule: "Repository rule",
  }[row.evidence.basis];
  return [row.scenario, row.impact, `${basis}: ${row.evidence.detail}`, `Fix: ${row.requestedChange}`]
    .map(humanText)
    .join(" ");
}

export function redactHumanFindings(rows: readonly HumanFinding[], redact: (s: string) => string): HumanFinding[] {
  return rows.map((row) => ({
    ...row,
    problem: redact(row.problem),
    scenario: redact(row.scenario),
    impact: redact(row.impact),
    requestedChange: redact(row.requestedChange),
    evidence: { ...row.evidence, detail: redact(row.evidence.detail) },
    location: { ...row.location, file: redact(row.location.file) },
  }));
}
