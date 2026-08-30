// One import site for the shared formatters (src/channels/*): the same
// implementations the bot's chat/CLI surfaces and the old server renderer use.

export { formatDateTime, formatElapsed, formatRelative, splitRunLabel } from "@core/channels/indexFormat.js";
export { formatLocalIso } from "@core/channels/localIso.js";
