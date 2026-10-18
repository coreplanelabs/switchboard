## Verification

- Choose focused checks for the affected user outcome. Prove the intended success and relevant failure behavior through the public entry point. Assert an independent expected result, not a value recomputed by the implementation. Preserve existing proof when refactoring.
- For changed error handling, verify propagation, translation or the defined recovery result. When telemetry changes, verify the required signal and its safe contents. A logger call alone does not prove correct failure handling.
- Use the repository's existing lint, type and behavior checks. Follow its scoped-check workflow and explicit user limits; these principles do not require a full suite for every edit. Docs or wording alone need text and link checks, not new behavior tests.
- Bind evidence to the tested revision or diff. Report skipped or unavailable checks and specific unknowns. Supplied instructions, green CI, review, merge, deployment and live acceptance are different facts.
