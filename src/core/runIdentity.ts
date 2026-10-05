/** A run id is an opaque ledger key, never a path. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A Workflow instance id: the platform's own alphabet, at most 100 characters. */
export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/;

/** `<parentInstanceId>:<step>` — the key retained by an admitted child. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}:[A-Za-z0-9_][A-Za-z0-9_./-]{0,255}$/;
