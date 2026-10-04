/** The finding shape advertised to native and load-harness reviewers. */
export const reviewFindingInputSchema = {
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
      description: "One line naming the issue (the full explanation goes in your review text)",
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
