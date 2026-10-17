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

const humanFieldGuidance = {
  problem:
    "What observable result is wrong, and for whom? Write one short sentence naming the failure and its effect. This becomes the bold public headline. Use familiar words, not an internal mechanism, code identifier or file path.",
  scenario:
    "What real action, input or existing state causes it? Name the conditions needed to reach the failure. Do not invent how often it happens. For a project-rule finding, name when the rule applies without inventing a runtime failure.",
  impact:
    "Why is a change needed? Say what the affected person or system cannot do, does incorrectly or loses. For a rule-only finding, identify the requirement being violated. Keep the impact consistent with the severity.",
  evidence:
    "What fact establishes the claim? Give the decisive fact and its limits in plain language. A code_trace must not imply a runtime reproduction. For a reproduction, name the environment and observed result. Keep full call chains and long code extracts in For agents.",
  requestedChange:
    "What is the smallest sufficient correction? Describe the needed behavior in plain language. Explain any essential technical term. Do not prescribe unrelated cleanup or a larger redesign.",
};

export const HUMAN_FINDINGS_INSTRUCTION = `WRITE FOR THE PERSON DECIDING WHAT TO CHANGE. For every active finding, including priorFindings, supply humanFindings keyed by its exact findingId. Answer these questions in the named fields:
- problem: ${humanFieldGuidance.problem}
- scenario: ${humanFieldGuidance.scenario}
- impact: ${humanFieldGuidance.impact}
- evidence.detail: ${humanFieldGuidance.evidence}
- requestedChange: ${humanFieldGuidance.requestedChange}

The public comment shows the problem first, then Why it matters (scenario and impact), Evidence, and Change. Do not repeat these labels inside the fields. Write short, direct sentences. Describe the person's action and the result in familiar words. Internal terms such as bind, admission, ingress, canonical, invariant or receipt must not stand in for the explanation. Say what they mean in this case, such as the selected pull request, the request check or the saved result. Keep exact code names in the location or the supporting agent text unless a name is essential to the correction; explain it when it is essential. Do not remove a real condition, uncertainty or important effect just to shorten the comment.

Example: problem="Users cannot continue connection setup." scenario="Finishing setup saves the result but does not send it to the browser." impact="Connect and Continue stay hidden until the request times out. Reloading restores them." evidence={basis:"code_trace",detail:"The code waits before sending the result. This was not reproduced."} requestedChange="Send the setup result before waiting."
Another example: write "Valid review requests are rejected when the pull request link is on a second line", not "The hard gate treats a shortened display receipt as complete target evidence". For a rule-only finding, write "The required restore instructions are missing", identify the rule, and do not claim that a restore has failed.

Before submitting, read the human fields with For agents hidden. Can a person name the problem, trigger, effect, proof limit and needed correction without translating code names or opening the source? If not, rewrite the explanation. If the failure or its importance is unsupported, drop the candidate under the review's finding-selection rules; clearer wording cannot make it valid.
State evidence.basis as code_trace, isolated_reproduction, deployed_reproduction or repository_rule. Give location={file,line?} at the reviewed head. Keep all human fields within 900 visible characters in total. Keep original finding metadata stable; update this explanation and location after partial fixes. Supply [] when there are no findings.`;

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
      problem: { type: "string", description: humanFieldGuidance.problem },
      scenario: { type: "string", description: humanFieldGuidance.scenario },
      impact: { type: "string", description: humanFieldGuidance.impact },
      requestedChange: { type: "string", description: humanFieldGuidance.requestedChange },
      evidence: {
        type: "object",
        additionalProperties: false,
        required: ["basis", "detail"],
        properties: {
          basis: {
            type: "string",
            enum: ["code_trace", "isolated_reproduction", "deployed_reproduction", "repository_rule"],
          },
          detail: { type: "string", description: humanFieldGuidance.evidence },
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
    code_trace: "From reading the code.",
    isolated_reproduction: "Reproduced in a separate test.",
    deployed_reproduction: "Reproduced on the deployed system.",
    repository_rule: "Project requirement.",
  }[row.evidence.basis];
  return [
    `**Why it matters:** ${humanText(row.scenario)} ${humanText(row.impact)}`,
    `**Evidence:** ${basis} ${humanText(row.evidence.detail)}`,
    `**Change:** ${humanText(row.requestedChange)}`,
  ].join("\n\n  ");
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
