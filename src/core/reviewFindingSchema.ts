/** The finding shape advertised to native and load-harness reviewers. */
const finding = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: 'Stable id assigned in order: "F1", "F2", … — dispositions reference it',
    },
    severity: {
      type: "string",
      enum: ["blocking", "major", "minor", "nit"],
      description: "blocking | major | minor | nit",
    },
    file: { type: "string", description: "Repo-relative file the finding points at" },
    line: { type: "integer", description: "1-based line number, when the finding points at one" },
    title: {
      type: "string",
      description:
        "One concise sentence, at most 180 characters, stating what fails and its impact in plain language; put paths, spec numbers and implementation detail in file/line or the evidence",
    },
    kind: {
      type: "string",
      enum: ["single", "pattern"],
      description: "single issue or pattern spanning multiple cases; pattern requires invariant and cases",
    },
    invariant: { type: "string", description: "The shared safety/correctness rule this pattern must hold" },
    cases: {
      type: "array",
      description:
        "All independently checkable cases of the invariant found in this diff, including selection and execution paths",
      items: {
        type: "object",
        properties: {
          scenario: { type: "string", description: "Concrete input or path through the invariant" },
          expected: { type: "string", description: "Required behavior on that path" },
        },
        required: ["scenario", "expected"],
      },
    },
    humanGated: {
      type: "boolean",
      description:
        "true ONLY when the remedy is a receipt only a person can produce (a credential-gated replay, a live procedure) — never for work a fix round could do",
    },
  },
  required: ["id", "severity", "file", "title", "kind"],
};

const { invariant, cases, ...singleProperties } = finding.properties;
const text = { type: "string", minLength: 1, pattern: "\\S" };
const caseInput = {
  ...cases.items,
  properties: {
    scenario: { ...cases.items.properties.scenario, ...text },
    expected: { ...cases.items.properties.expected, ...text },
  },
  additionalProperties: false,
};

/** Discriminated alternatives prevent a single issue from advertising a pattern matrix. */
export const reviewFindingInputSchema = {
  anyOf: [
    {
      type: "object",
      properties: { ...singleProperties, kind: { type: "string", enum: ["single"] } },
      required: finding.required,
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ...singleProperties,
        kind: { type: "string", enum: ["pattern"] },
        invariant: { ...invariant, ...text },
        cases: {
          ...cases,
          minItems: 1,
          items: caseInput,
        },
      },
      required: [...finding.required, "invariant", "cases"],
      additionalProperties: false,
    },
    {
      type: "object",
      description:
        "Re-raise an outstanding finding by its exact scoped ID. Original metadata and cases are preserved; cases here are new additions only. Assess every prior case in caseAssessments.",
      properties: {
        id: { type: "string", pattern: "^review:", description: "Exact scoped ID from outstandingFindings" },
        cases: {
          ...cases,
          items: caseInput,
          description: "New cases only; do not copy prior cases or supply case IDs",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  ],
};

export const caseAssessmentInputSchema = {
  type: "array",
  description:
    "One assessment for every case of every outstanding finding, including findings you resolve. Original case text is preserved by the tool.",
  items: {
    type: "object",
    properties: {
      findingId: { ...text, description: "Exact scoped finding ID from outstandingFindings" },
      caseId: {
        type: "string",
        pattern: "^C[1-9]\\d*$",
        description: "Exact case ID from that finding's cases, such as C1",
      },
      outcome: {
        type: "string",
        enum: ["open", "fixed", "declined"],
        description:
          "open if still failing; fixed after verifying the repair; declined after verifying the case does not apply",
      },
      note: {
        ...text,
        description:
          "Evidence at the reviewed head: checked paths or tests, observed result and reason for this outcome",
      },
    },
    required: ["findingId", "caseId", "outcome", "note"],
    additionalProperties: false,
  },
};
