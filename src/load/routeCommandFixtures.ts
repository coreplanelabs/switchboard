// The command fixtures of the route replay (record 0036, units 2 and 3): for
// every command the router is offered — the full-capability catalogue's chat
// surface — a fixture of each kind. A happy path binds every required argument
// as a person would say it; a paraphrase asks for the same thing in other
// words; a decoy names the command's subject without asking for what the
// command does, so any command call is a miss (unless `allow` names it). A
// command may carry further decoys, each a production miss pinned verbatim.
// The conformance fence (src/core/commandConformance.test.ts) holds every
// offered command to at least one of each kind, so a command added to the
// catalogue fails `verify` by name until its fixtures land. Neutral names only (acme/…, r-N, m-N): the public
// tree carries no private references.

/** One example: the text as typed, the repository the thread names (when the
 *  request leaves it to the thread), the command the router must call and the
 *  input it must bind — in the registry's `{ args, options }` shape, compared
 *  after `parseInput` so `"7"` and `7` agree where the schema coerces. */
export interface RouteCommandFixture {
  id: string;
  kind: "happy" | "paraphrase";
  text: string;
  threadRepo?: string;
  command: string;
  input: { args?: readonly unknown[]; options?: Record<string, unknown> };
}

/** A decoy: a request that mentions a command's subject but asks for something
 *  no command does exactly — a judgement, a diagnosis, a change — so a call to
 *  ANY command is a miss; `allow` names the commands a call to which is still
 *  counted right (a request a command does cover, phrased loosely). `command`
 *  is the command whose subject the decoy borrows: the fence's key. */
export interface RouteCommandDecoy {
  id: string;
  kind: "decoy";
  text: string;
  command: string;
  allow?: readonly string[];
}

const f = (
  id: string,
  kind: RouteCommandFixture["kind"],
  text: string,
  command: string,
  input: RouteCommandFixture["input"] = { args: [], options: {} },
  threadRepo?: string,
): RouteCommandFixture => ({ id, kind, text, command, input, ...(threadRepo ? { threadRepo } : {}) });

export const ROUTE_COMMAND_FIXTURES: readonly RouteCommandFixture[] = [
  f("c01h", "happy", "what can you do", "help.show"),
  f("c01p", "paraphrase", "how do I talk to you — what are my options here?", "help.show"),
  f("c02h", "happy", "list every chat command", "help.commands"),
  f("c02p", "paraphrase", "show me all the commands, grouped", "help.commands"),
  f("c03h", "happy", "which build are you running", "status.show"),
  f("c03p", "paraphrase", "what version is this bot on right now", "status.show"),
  f("c04h", "happy", "show me the config for this channel", "config.show"),
  f("c04p", "paraphrase", "what agent, model and effort am I on here?", "config.show"),
  f("c05h", "happy", "which channels carry config overrides", "config.overrides"),
  f("c05p", "paraphrase", "list the channels that have their own settings", "config.overrides"),
  f("c36h", "happy", "which channels can I pick settings for", "config.channels"),
  f("c36p", "paraphrase", "list the channels you are in, by name", "config.channels"),
  f("c39h", "happy", "what is happening right now", "plane.show"),
  f(
    "c39p",
    "paraphrase",
    "give me the table: every live run, unit and pull request with its owner and health",
    "plane.show",
  ),
  f("c06h", "happy", "use anthropic/claude-opus-5 for coding in this channel", "config.set", {
    args: ["channel"],
    options: { models: { coding: "anthropic/claude-opus-5" } },
  }),
  f("c06p", "paraphrase", "set my effort to high", "config.set", { args: ["me"], options: { effort: "high" } }),
  f("c07h", "happy", "clear my config overrides", "config.clear", { args: ["me"], options: {} }),
  f("c07p", "paraphrase", "reset this channel's settings back to the defaults", "config.clear", {
    args: ["channel"],
    options: {},
  }),
  f("c08h", "happy", 'set my custom instructions to "always answer in French"', "config.instructions", {
    args: ["me", "always answer in French"],
    options: {},
  }),
  f("c08p", "paraphrase", 'for this channel, the standing instruction is "keep replies short"', "config.instructions", {
    args: ["channel", "keep replies short"],
    options: {},
  }),
  f("c09h", "happy", "how many runs today", "runs.list"),
  f("c09p", "paraphrase", "show the latest runs", "runs.list"),
  f("c10h", "happy", "stop run r-123, soft", "runs.stop", { args: ["r-123"], options: { mode: "soft" } }),
  f("c10p", "paraphrase", "abort run r-9 right now, hard stop", "runs.stop", {
    args: ["r-9"],
    options: { mode: "hard" },
  }),
  f("c11h", "happy", "show the runs of unit ship-acme-1:U16", "runs.unit", { args: ["ship-acme-1:U16"], options: {} }),
  f("c11p", "paraphrase", "which runs belong to unit ship-acme-1:U17?", "runs.unit", {
    args: ["ship-acme-1:U17"],
    options: {},
  }),
  f("c12h", "happy", "list the children of run r-42", "runs.children", { args: ["r-42"], options: {} }),
  f("c12p", "paraphrase", "which runs did run r-7 spawn?", "runs.children", { args: ["r-7"], options: {} }),
  f("c13h", "happy", "abridge the review of run r-11", "review.abridge", { args: ["r-11"], options: {} }),
  f("c13p", "paraphrase", "shorten run r-12's review diff for reading", "review.abridge", {
    args: ["r-12"],
    options: {},
  }),
  f("c14h", "happy", "show the friction report", "friction.report"),
  f("c14p", "paraphrase", "what friction patterns keep recurring across runs?", "friction.report"),
  f("c15h", "happy", "file the top friction proposals as issues", "friction.propose"),
  f("c15p", "paraphrase", "run the self-improvement step", "friction.propose"),
  f("c16h", "happy", "which repos are onboarded", "repo.list"),
  f("c16p", "paraphrase", "list the resident repos and their state", "repo.list"),
  f("c17h", "happy", "onboard acme/api", "repo.onboard", { args: ["acme/api"], options: {} }),
  f("c17p", "paraphrase", "make acme/web a resident repo", "repo.onboard", { args: ["acme/web"], options: {} }),
  f("c18h", "happy", "offboard acme/api", "repo.offboard", { args: ["acme/api"], options: {} }),
  f("c18p", "paraphrase", "tear down the acme/web resident", "repo.offboard", { args: ["acme/web"], options: {} }),
  f("c19h", "happy", "reconfigure acme/api", "repo.reconfigure", { args: ["acme/api"], options: {} }),
  f("c19p", "paraphrase", "change acme/web's resident configuration", "repo.reconfigure", {
    args: ["acme/web"],
    options: {},
  }),
  f("c20h", "happy", "rebuild acme/api", "repo.rebuild", { args: ["acme/api"], options: {} }),
  f("c20p", "paraphrase", "reprovision the acme/web resident from scratch", "repo.rebuild", {
    args: ["acme/web"],
    options: {},
  }),
  f("c21h", "happy", "run the tests on main", "repo.test", { args: ["acme/api", "main"], options: {} }, "acme/api"),
  f("c21p", "paraphrase", "run acme/web's test suite", "repo.test", { args: ["acme/web"], options: {} }),
  f("c22h", "happy", "build acme/api on main", "repo.build", { args: ["acme/api", "main"], options: {} }),
  f("c22p", "paraphrase", "run the build", "repo.build", { args: ["acme/web"], options: {} }, "acme/web"),
  f("c23h", "happy", "list my memory records", "memory.list"),
  f("c23p", "paraphrase", "what do you remember that influences my runs?", "memory.list"),
  f("c24h", "happy", "forget memory mem:org:3", "memory.forget", { args: ["mem:org:3"], options: {} }),
  f("c24p", "paraphrase", "delete the memory record mem:org:8", "memory.forget", {
    args: ["mem:org:8"],
    options: {},
  }),
  f("c38h", "happy", "sweep the stale status records out of my memory scope", "memory.sweep", {
    args: [],
    options: { scope: "me" },
  }),
  f("c38p", "paraphrase", "retire the org memory records that are just old status lines", "memory.sweep", {
    args: [],
    options: { scope: "org" },
  }),
  f("c25h", "happy", "list the mcp servers", "mcp.list"),
  f("c25p", "paraphrase", "which external MCP servers can my runs use here?", "mcp.list"),
  f("c26h", "happy", "add an mcp server named crm at https://crm.example/mcp", "mcp.add", {
    args: ["crm"],
    options: { url: "https://crm.example/mcp" },
  }),
  f("c26p", "paraphrase", "register https://tools.example/mcp as an mcp server called tools", "mcp.add", {
    args: ["tools"],
    options: { url: "https://tools.example/mcp" },
  }),
  f("c27h", "happy", "give me a sign-in link for the crm mcp server", "mcp.connect", { args: ["crm"], options: {} }),
  f("c27p", "paraphrase", "I need to re-enter the token for the tools server", "mcp.connect", {
    args: ["tools"],
    options: {},
  }),
  f("c28h", "happy", "show the crm mcp server", "mcp.show", { args: ["crm"], options: {} }),
  f("c28p", "paraphrase", "what tools does the crm server offer?", "mcp.show", { args: ["crm"], options: {} }),
  f("c29h", "happy", "remove the crm mcp server", "mcp.remove", { args: ["crm"], options: {} }),
  f("c29p", "paraphrase", "delete the tools server and its stored credential", "mcp.remove", {
    args: ["tools"],
    options: {},
  }),
  f("c33h", "happy", "promote the crm mcp server of slack:U0ACME01 to the org", "mcp.promote", {
    args: ["crm"],
    options: { from: "slack:U0ACME01" },
  }),
  f("c33p", "paraphrase", "make slack:U0ACME02's personal tools server an org-wide one", "mcp.promote", {
    args: ["tools"],
    options: { from: "slack:U0ACME02" },
  }),
  f("c30h", "happy", "list the scheduled jobs", "schedule.list"),
  f("c30p", "paraphrase", "what cron jobs are there and when do they fire next?", "schedule.list"),
  f("c31h", "happy", "show the deploy plan", "deploy.plan"),
  f("c31p", "paraphrase", "what would a production deploy do right now?", "deploy.plan"),
  f("c32h", "happy", "show the delivery report", "delivery.report"),
  f("c32p", "paraphrase", "how long from issue to merge have we been running lately?", "delivery.report"),
  f("c33h", "happy", "take a fresh costs snapshot now", "costs.snapshot"),
  f("c33p", "paraphrase", "refresh the spend numbers on the costs page", "costs.snapshot"),
  f("c34h", "happy", "show the findings ledger for acme/api#42", "runs.findings", {
    args: ["acme/api#42"],
    options: {},
  }),
  f(
    "c34p",
    "paraphrase",
    "what happened to each review finding on https://github.com/acme/api/pull/7?",
    "runs.findings",
    {
      args: ["https://github.com/acme/api/pull/7"],
      options: {},
    },
  ),
  f("c35h", "happy", "what did each user spend on runs over the last 7 days", "costs.by", {
    args: ["user"],
    options: { days: 7 },
  }),
  f("c35p", "paraphrase", "break the run spend down by agent", "costs.by", { args: ["agent"], options: {} }),
  f("c37h", "happy", "check our aggregator models against the provider's endpoints", "providers.check"),
  f("c37p", "paraphrase", "does the model registry still match what openrouter actually serves?", "providers.check"),
  // The steer (record 0057): words into a live run, by run id.
  f("c38h", "happy", "steer run run-8f2 to also update the changelog", "steer.run", {
    args: ["run-8f2", "also update the changelog"],
    options: {},
  }),
  f("c38p", "paraphrase", "tell the run run-8f2 that it should also update the changelog", "steer.run", {
    args: ["run-8f2", "it should also update the changelog"],
    options: {},
  }),
];

const d = (id: string, text: string, command: string, allow?: readonly string[]): RouteCommandDecoy => ({
  id,
  kind: "decoy",
  text,
  command,
  ...(allow ? { allow } : {}),
});

export const ROUTE_COMMAND_DECOYS: readonly RouteCommandDecoy[] = [
  d("c01d", "help me fix this bug", "help.show"),
  // Two production replies that bound `help.show` in one pipeline thread: a
  // person asking for the delivered work's screenshots.
  d("c01e", "show me screenshots", "help.show"),
  d("c01f", "attach UI screenshots of what you delivered to this slack thread", "help.show"),
  d("c02d", "which command should I have used for that?", "help.commands", ["help.commands", "help.show"]),
  d("c03d", "should we upgrade to the newest build?", "status.show"),
  d("c04d", "is the config for this channel sensible?", "config.show"),
  d("c05d", "why does this channel behave differently from the others?", "config.overrides"),
  d("c36d", "which channel would be the best home for the review bot?", "config.channels"),
  d("c39d", "what happened to the release last night and who dropped the ball?", "plane.show"),
  // Asks what a run is doing, not for words to be folded into it.
  d("c38d", "what is run run-8f2 doing right now?", "steer.run", ["runs.get", "runs.list"]),
  d("c06d", "what would be a good model for coding work here?", "config.set"),
  d("c07d", "did anyone change the settings here recently?", "config.clear"),
  d("c08d", "are my instructions actually being followed?", "config.instructions", ["config.instructions"]),
  d("c09d", "why did the last run fail", "runs.list"),
  d("c10d", "should I stop the run that is taking forever?", "runs.stop"),
  d("c11d", "how is the plan's second unit going overall?", "runs.unit"),
  d("c12d", "did the conductor's children do a good job?", "runs.children"),
  d("c13d", "was that review too long to be useful?", "review.abridge"),
  d("c14d", "this process feels slow, what should we change?", "friction.report"),
  d("c15d", "do we have too many open issues already?", "friction.propose"),
  d("c16d", "which of our repos has the most open pull requests", "repo.list"),
  d("c17d", "is acme/api worth onboarding as a resident?", "repo.onboard"),
  d("c18d", "do we still need the acme/api resident?", "repo.offboard"),
  d("c19d", "is the build command configured for acme/api the right one?", "repo.reconfigure"),
  d("c20d", "why does the acme/api snapshot keep going stale?", "repo.rebuild"),
  d("c21d", "are the tests in acme/api flaky?", "repo.test"),
  d("c22d", "why is the acme/api build so slow?", "repo.build"),
  d("c23d", "do you remember our conversation from yesterday?", "memory.list", ["memory.list"]),
  d("c24d", "forget it, never mind", "memory.forget"),
  d("c38d", "is memory mostly stale status lines by now?", "memory.sweep", ["memory.list"]),
  d("c25d", "is the mcp integration any good?", "mcp.list"),
  d("c26d", "would connecting our crm over mcp be worth it?", "mcp.add"),
  d("c27d", "why does the crm server keep disconnecting?", "mcp.connect"),
  d("c28d", "is the crm server safe to let runs use?", "mcp.show"),
  d("c29d", "should we drop the crm server?", "mcp.remove"),
  d("c33d", "is the crm server worth making org-wide, or should people keep their own?", "mcp.promote"),
  d("c30d", "is the refresh schedule too aggressive?", "schedule.list"),
  d("c31d", "should we deploy today or wait for the fix?", "deploy.plan"),
  d("c32d", "are we shipping fast enough this quarter?", "delivery.report", ["delivery.report"]),
  d("c33d", "why did our spend jump yesterday?", "costs.snapshot"),
  d("c34d", "was the reviewer right to decline the fix on acme/api#42?", "runs.findings"),
  d("c35d", "is the review agent worth what it costs us?", "costs.by"),
  d("c37d", "which openrouter model should the coding preset run on?", "providers.check"),
];

/** Every example of the command half, fixtures then decoys, for one replay. */
export type RouteCommandExample = RouteCommandFixture | RouteCommandDecoy;

export const ROUTE_COMMAND_EXAMPLES: readonly RouteCommandExample[] = [
  ...ROUTE_COMMAND_FIXTURES,
  ...ROUTE_COMMAND_DECOYS,
];
