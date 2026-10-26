/** A temporary source read did not recover inside the original run's local wait. */
export class ModelSourceUnavailableError extends Error {
  constructor() {
    super("Switchboard could not verify this run's source before its retry window ended.");
    this.name = "ModelSourceUnavailableError";
  }
}
