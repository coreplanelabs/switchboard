## Observability

- Use the repository's structured logging, metrics, tracing and correlation helpers. Give an unexpected failure one reporting owner at the appropriate boundary. Avoid duplicate reports at each layer. Expected recovery needs only the signals required by its contract.
- Record the operation, outcome and safe context needed to diagnose it. Preserve request, trace or task correlation through existing mechanisms. Keep metric labels bounded; do not use request IDs or arbitrary error messages as metric labels.
- Keep credentials, private payloads and sensitive error details out of telemetry. Use existing redaction and error-serialization helpers. Add a signal for a concrete diagnostic need; avoid noisy events and new telemetry frameworks without such a need.
