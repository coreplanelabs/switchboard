// The command fixtures of the route replay (record 0036, unit 2; unit 3
// completes the set and drives it): one plain-words request per offered
// command that the router should bind to that command with that input, plus
// decoys that look like a command and must not bind. The seed here is the
// happy path of the commands people type most; unit 3 adds the conformance
// fence (three fixtures per command) and the replay rows. Neutral names only
// (acme/…): the public tree carries no private references.

/** One example: the text as typed, the repository the thread names (when the
 *  request leaves it to the thread), the command the router must call and the
 *  input it must bind — in the registry's `{ args, options }` shape, compared
 *  after `parseInput` so `"7"` and `7` agree where the schema coerces. */
export interface RouteCommandFixture {
  id: string;
  text: string;
  threadRepo?: string;
  command: string;
  input: { args?: readonly unknown[]; options?: Record<string, unknown> };
}

/** A decoy: a request that mentions a command's subject but asks for something
 *  no command does exactly, so any command call is a miss; `allow` names the
 *  one command a call to which is still counted right (a request a command
 *  does cover, phrased loosely). */
export interface RouteCommandDecoy {
  id: string;
  text: string;
  allow?: string;
}

export const ROUTE_COMMAND_FIXTURES: readonly RouteCommandFixture[] = [
  { id: "c01", text: "how many runs today", command: "runs.list", input: { args: [], options: {} } },
  { id: "c02", text: "show me the config for this channel", command: "config.show", input: { args: [], options: {} } },
  { id: "c03", text: "which repos are onboarded", command: "repo.list", input: { args: [], options: {} } },
  { id: "c04", text: "what can you do", command: "help.show", input: { args: [], options: {} } },
  { id: "c05", text: "list the mcp servers", command: "mcp.list", input: { args: [], options: {} } },
  {
    id: "c06",
    text: "run the tests on main",
    threadRepo: "acme/api",
    command: "repo.test",
    input: { args: ["acme/api", "main"], options: {} },
  },
  {
    id: "c07",
    text: "use opus for coding in this channel",
    command: "config.set",
    input: { args: ["channel"], options: { models: { coding: "anthropic/claude-opus-5" } } },
  },
];

export const ROUTE_COMMAND_DECOYS: readonly RouteCommandDecoy[] = [
  { id: "d01", text: "why did the last run fail" },
  { id: "d02", text: "is the config for this channel sensible" },
  { id: "d03", text: "which of our repos has the most open pull requests" },
];
