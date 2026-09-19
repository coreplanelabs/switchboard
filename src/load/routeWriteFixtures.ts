// The checked-in write set of `load:route` (docs/reference/specs/load-harness.md
// item 17): write binds spelled as a person asks for them, each carrying the
// command the person meant, its required arguments, the repository where the
// bind names one, and — deliberately — the optional arguments left unset. The
// write row counts misbinds against these fixtures: a wrong command, a wrong
// required argument, a wrong repository, or a filled optional argument the
// fixture did not name; a bind that omits an optional the fixture set counts
// none (leaving an asked nicety out is not a wrong write). Neutral names only
// (acme/…, r-N, mem:…): the public tree carries no private references.

/** One write bind: the text as typed, the command and the input the person
 *  meant — in the registry's `{ args, options }` shape, compared after
 *  `parseInput` on both sides — and where the repository sits in that input
 *  (an argument index or an option key), so a wrong repository is a misbind
 *  class of its own. The options here are the optionals the fixture set;
 *  every other optional must stay unset. */
export interface RouteWriteFixture {
  id: string;
  text: string;
  threadRepo?: string;
  command: string;
  input: { args?: readonly unknown[]; options?: Record<string, unknown> };
  repo?: { arg: number } | { option: string };
}

const w = (
  id: string,
  text: string,
  command: string,
  input: RouteWriteFixture["input"],
  repo?: RouteWriteFixture["repo"],
): RouteWriteFixture => ({ id, text, command, input, ...(repo ? { repo } : {}) });

export const ROUTE_WRITE_FIXTURES: readonly RouteWriteFixture[] = [
  w("w01", "onboard acme/api as a warm resident", "repo.onboard", { args: ["acme/api"], options: {} }, { arg: 0 }),
  w(
    "w02",
    "onboard acme/web and evict the coldest resident if the fleet is full",
    "repo.onboard",
    { args: ["acme/web"], options: { evictColdest: true } },
    { arg: 0 },
  ),
  w("w03", "offboard the acme/api resident", "repo.offboard", { args: ["acme/api"], options: {} }, { arg: 0 }),
  w(
    "w04",
    "rebuild the acme/web resident from a fresh snapshot",
    "repo.rebuild",
    { args: ["acme/web"], options: {} },
    { arg: 0 },
  ),
  w(
    "w05",
    "point the acme/api resident's test command at npm run test:fast",
    "repo.reconfigure",
    { args: ["acme/api"], options: { test: "npm run test:fast" } },
    { arg: 0 },
  ),
  w("w06", "stop run r-55 now, hard", "runs.stop", { args: ["r-55"], options: { mode: "hard" } }),
  w("w07", "stop run r-56 softly — let it finish the current step", "runs.stop", {
    args: ["r-56"],
    options: { mode: "soft" },
  }),
  w("w08", "forget the memory record mem:org:5", "memory.forget", { args: ["mem:org:5"], options: {} }),
  w("w09", "set my effort to low", "config.set", { args: ["me"], options: { effort: "low" } }),
  w("w10", "reset this channel's settings to the defaults", "config.clear", { args: ["channel"], options: {} }),
  w("w11", 'set this channel\'s instructions to "keep replies short"', "config.instructions", {
    args: ["channel", "keep replies short"],
    options: {},
  }),
  w("w12", "add an mcp server named wiki at https://wiki.example/mcp", "mcp.add", {
    args: ["wiki"],
    options: { url: "https://wiki.example/mcp" },
  }),
  w("w13", "remove the wiki mcp server and its stored credential", "mcp.remove", { args: ["wiki"], options: {} }),
];
