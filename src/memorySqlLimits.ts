// Shared SQL limits are values, not Worker entrypoints. Keep them outside the
// entry module so Workerd sees only supported handlers, functions and classes.
export const DO_MAX_BOUND_PARAMETERS = 100;
/** Rows per `INSERT INTO run_events` statement: floor(100 / 3 parameters). */
export const RUN_EVENT_INSERT_BATCH = Math.floor(DO_MAX_BOUND_PARAMETERS / 3);
