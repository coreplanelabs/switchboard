/** The state Worker timeout and single run-history store key shared by the
 * bot client and resident preservation read. Keep this module Worker-safe. */
export const RUN_STORE_TIMEOUT_MS = 10_000;
export const RUN_STORE_KEY = "runs:default";
